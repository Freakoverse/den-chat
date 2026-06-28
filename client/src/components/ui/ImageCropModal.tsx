/**
 * ImageCropModal — edit an image before uploading it.
 *
 * Opens on top of the profile editor when a picture/banner is dropped or picked.
 * Lets the user zoom, rotate, and pan within a fixed-aspect crop frame, then
 * renders the visible region to a new image and hands it back via onSave. The
 * cover math + pan clamping guarantee the crop is always filled (no gaps), so the
 * default view already fills the frame. Pointer events cover mouse and touch.
 *
 * GIFs only edit their first frame (canvas is static) — a note nudges the user to
 * "Upload without modifications" to keep the animation.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { X, RotateCcw, RotateCw, RefreshCw, Loader2, ZoomIn } from 'lucide-react'

interface ImageCropModalProps {
  file: File
  aspect?: number        // crop width / height (1 = square)
  round?: boolean        // show a circular guide (output stays the cropped rectangle)
  maxOutput?: number     // cap on output width in px
  title?: string
  onCancel: () => void
  onUploadOriginal: () => void
  onSave: (file: File) => void
}

const FRAME_W = 320

export function ImageCropModal({ file, aspect = 1, round, maxOutput = 1024, title = 'Edit image', onCancel, onUploadOriginal, onSave }: ImageCropModalProps) {
  const frameH = Math.round(FRAME_W / aspect)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [zoomFactor, setZoomFactor] = useState(1)     // 1 = cover (fills frame, no gaps)
  const [rotationDeg, setRotationDeg] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })       // screen px from center
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const isGif = file.type === 'image/gif'

  // Load the dropped image
  useEffect(() => {
    const url = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => setImg(im)
    im.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  // Minimum scale so the (rotated) image still covers the frame → never any gaps.
  const coverScale = useCallback((a: number) => {
    if (!img) return 1
    const iw = img.naturalWidth, ih = img.naturalHeight
    const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a))
    const halfProjX = (FRAME_W / 2) * ca + (frameH / 2) * sa
    const halfProjY = (FRAME_W / 2) * sa + (frameH / 2) * ca
    return Math.max((2 * halfProjX) / iw, (2 * halfProjY) / ih)
  }, [img, frameH])

  // Clamp a screen-space pan so the frame stays fully inside the image.
  const clampPan = useCallback((px: number, py: number, a: number, s: number) => {
    if (!img) return { x: 0, y: 0 }
    const iw = img.naturalWidth, ih = img.naturalHeight
    const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a))
    const halfProjX = (FRAME_W / 2) * ca + (frameH / 2) * sa
    const halfProjY = (FRAME_W / 2) * sa + (frameH / 2) * ca
    const maxLX = Math.max(0, (s * iw) / 2 - halfProjX)
    const maxLY = Math.max(0, (s * ih) / 2 - halfProjY)
    // screen → image-local (rotate by -a), clamp, then back to screen (rotate by a)
    let lx = px * Math.cos(-a) - py * Math.sin(-a)
    let ly = px * Math.sin(-a) + py * Math.cos(-a)
    lx = Math.max(-maxLX, Math.min(maxLX, lx))
    ly = Math.max(-maxLY, Math.min(maxLY, ly))
    return { x: lx * Math.cos(a) - ly * Math.sin(a), y: lx * Math.sin(a) + ly * Math.cos(a) }
  }, [img, frameH])

  // Re-clamp pan whenever zoom/rotation change (keeps the frame covered).
  useEffect(() => {
    const a = (rotationDeg * Math.PI) / 180
    const s = coverScale(a) * zoomFactor
    setPan((p) => {
      const c = clampPan(p.x, p.y, a, s)
      return c.x === p.x && c.y === p.y ? p : c
    })
  }, [rotationDeg, zoomFactor, coverScale, clampPan])

  // Draw the current transform onto a canvas scaled by k (k=dpr for preview, k=out/FRAME for export).
  const drawTo = useCallback((canvas: HTMLCanvasElement, k: number) => {
    if (!img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cw = Math.round(FRAME_W * k), ch = Math.round(frameH * k)
    canvas.width = cw; canvas.height = ch
    ctx.clearRect(0, 0, cw, ch)
    const a = (rotationDeg * Math.PI) / 180
    const s = coverScale(a) * zoomFactor
    ctx.save()
    ctx.translate(cw / 2 + pan.x * k, ch / 2 + pan.y * k)
    ctx.rotate(a)
    ctx.scale(s * k, s * k)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
    ctx.restore()
  }, [img, frameH, rotationDeg, zoomFactor, pan, coverScale])

  // Preview redraw
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !img) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    drawTo(c, dpr)
    c.style.width = `${FRAME_W}px`
    c.style.height = `${frameH}px`
  }, [img, drawTo, frameH])

  // ── Pointer (mouse + touch) panning ──
  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const a = (rotationDeg * Math.PI) / 180
    const s = coverScale(a) * zoomFactor
    setPan(clampPan(dragRef.current.px + (e.clientX - dragRef.current.x), dragRef.current.py + (e.clientY - dragRef.current.y), a, s))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  const reset = () => { setZoomFactor(1); setRotationDeg(0); setPan({ x: 0, y: 0 }) }

  const handleSave = async () => {
    if (!img) return
    setBusy(true)
    try {
      const a = (rotationDeg * Math.PI) / 180
      const s = coverScale(a) * zoomFactor
      // Output at ~native resolution across the frame (no upscaling), capped.
      const outW = Math.min(maxOutput, Math.max(64, Math.round(FRAME_W / s)))
      const out = document.createElement('canvas')
      drawTo(out, outW / FRAME_W)
      const mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, mime, mime === 'image/jpeg' ? 0.92 : undefined))
      if (!blob) { setBusy(false); return }
      const ext = mime === 'image/jpeg' ? 'jpg' : 'png'
      onSave(new File([blob], `crop.${ext}`, { type: mime }))
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-card border border-border shadow-2xl flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button onClick={onCancel} disabled={busy} className="text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer"><X size={18} /></button>
        </div>

        <div className="p-5 flex flex-col items-center gap-4 overflow-y-auto">
          {/* Crop preview */}
          <div className="relative select-none touch-none" style={{ width: FRAME_W, height: frameH }}>
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="rounded-lg bg-secondary/40 cursor-grab active:cursor-grabbing touch-none"
              style={{ width: FRAME_W, height: frameH }}
            />
            {/* guide overlay */}
            <div
              className="pointer-events-none absolute inset-0 rounded-lg"
              style={round
                ? { borderRadius: '9999px', boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)', outline: '2px solid rgba(255,255,255,0.5)' }
                : { boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.5)' }}
            />
            {!img && (
              <div className="absolute inset-0 flex items-center justify-center text-muted-foreground"><Loader2 size={20} className="animate-spin" /></div>
            )}
          </div>

          <p className="text-[11px] text-muted-foreground -mt-1">Drag to reposition · the frame is always filled</p>

          {/* Zoom slider */}
          <div className="w-full flex items-center gap-2">
            <ZoomIn size={15} className="text-muted-foreground shrink-0" />
            <input type="range" min={1} max={4} step={0.01} value={zoomFactor}
              onChange={(e) => setZoomFactor(Number(e.target.value))}
              className="flex-1 h-1.5 accent-primary cursor-pointer" />
            <span className="text-[10px] font-mono text-muted-foreground w-9 text-right tabular-nums">{zoomFactor.toFixed(2)}×</span>
          </div>

          {/* Rotation slider + 90° buttons */}
          <div className="w-full flex items-center gap-2">
            <button onClick={() => setRotationDeg((r) => r - 90)} title="Rotate left 90°" className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer"><RotateCcw size={15} /></button>
            <input type="range" min={-180} max={180} step={1} value={rotationDeg}
              onChange={(e) => setRotationDeg(Number(e.target.value))}
              className="flex-1 h-1.5 accent-primary cursor-pointer" />
            <button onClick={() => setRotationDeg((r) => r + 90)} title="Rotate right 90°" className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer"><RotateCw size={15} /></button>
            <span className="text-[10px] font-mono text-muted-foreground w-9 text-right tabular-nums">{rotationDeg}°</span>
          </div>

          <button onClick={reset} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <RefreshCw size={12} /> Reset to default
          </button>

          {isGif && (
            <p className="text-[11px] text-amber-400/90 text-center">Editing a GIF saves a still image. Use “Upload without modifications” to keep it animated.</p>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-2 px-5 py-3 border-t border-border shrink-0">
          <button onClick={onUploadOriginal} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer text-left">Upload without modifications</button>
          <div className="flex items-center justify-end gap-2">
            <button onClick={onCancel} disabled={busy} className="px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 cursor-pointer">Cancel</button>
            <button onClick={handleSave} disabled={busy || !img} className="px-3.5 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer">
              {busy && <Loader2 size={14} className="animate-spin" />} Save &amp; upload
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
