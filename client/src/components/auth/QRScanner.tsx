/**
 * QRScanner — full-screen camera QR reader (jsQR, works on iOS Safari + Android).
 *
 * Used to scan an encrypted-backup QR for vault import. Calls onResult with the
 * decoded text on the first successful read, then the parent closes it.
 */
import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { Loader2, X } from 'lucide-react'

export function QRScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    let done = false

    const tick = () => {
      const video = videoRef.current, canvas = canvasRef.current
      if (cancelled || done || !video || !canvas) return
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth, h = video.videoHeight
        if (w && h) {
          canvas.width = w; canvas.height = h
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h)
            const img = ctx.getImageData(0, 0, w, h)
            const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
            if (code && code.data) { done = true; onResultRef.current(code.data); return }
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera not available on this device')
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        setReady(true)
        rafRef.current = requestAnimationFrame(tick)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not access the camera')
      }
    }

    start()
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/95 p-4">
      <button onClick={onClose} className="absolute top-4 right-4 text-white/80 hover:text-white cursor-pointer" aria-label="Close scanner"><X size={24} /></button>
      {error ? (
        <div className="text-center max-w-xs space-y-3">
          <p className="text-sm text-destructive">{error}</p>
          <button onClick={onClose} className="text-sm text-white/80 hover:text-white underline cursor-pointer">Close</button>
        </div>
      ) : (
        <>
          <div className="relative w-full max-w-xs aspect-square rounded-2xl overflow-hidden border-2 border-white/20 bg-black">
            <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
            {!ready && <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin text-white" /></div>}
            <div className="absolute inset-8 border-2 border-primary rounded-xl pointer-events-none" />
          </div>
          <p className="text-sm text-white/80 mt-4 text-center">Point your camera at the backup QR code</p>
        </>
      )}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  )
}
