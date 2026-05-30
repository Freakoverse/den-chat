/**
 * CustomAudioPlayer — Cross-browser seekable audio player
 *
 * Replaces native <audio controls> which can't seek in MediaRecorder blobs
 * (WebM/Ogg lack duration metadata). Uses a hidden <audio> element with a
 * custom UI: play/pause button, click-to-seek progress bar, and time display.
 *
 * Uses requestAnimationFrame for smooth 60fps progress bar animation.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Play, Pause } from 'lucide-react'

interface CustomAudioPlayerProps {
  /** Audio source URL */
  src: string
  /** Optional known duration in seconds (for MediaRecorder blobs where metadata is missing) */
  knownDuration?: number
  /** Optional title displayed above the player (e.g. filename) */
  title?: string
  /** Optional className for the outer container */
  className?: string
  /** Optional callback when audio data has loaded */
  onLoadedData?: () => void
  /** Optional callback on load error */
  onError?: (e: React.SyntheticEvent<HTMLAudioElement>) => void
  /** Preload strategy (default: "metadata") */
  preload?: 'none' | 'metadata' | 'auto'
}

/** Format seconds as mm:ss */
function fmtTime(sec: number): string {
  if (!isFinite(sec) || isNaN(sec) || sec < 0) return '00:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

export function CustomAudioPlayer({
  src,
  knownDuration,
  title,
  className = '',
  onLoadedData,
  onError,
  preload = 'metadata',
}: CustomAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number>(0)
  // Keep duration in a ref too so rAF tick can read it without stale closures
  const durRef = useRef(knownDuration || 0)

  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackPos, setPlaybackPos] = useState(0)
  const [duration, _setDuration] = useState(knownDuration || 0)

  const setDuration = useCallback((d: number) => {
    durRef.current = d
    _setDuration(d)
  }, [])

  // ── Try to resolve duration from the audio element ──
  const tryResolveDuration = useCallback((el: HTMLAudioElement) => {
    if (knownDuration) {
      if (durRef.current !== knownDuration) setDuration(knownDuration)
      return
    }
    const d = el.duration
    if (isFinite(d) && d > 0 && d !== durRef.current) {
      setDuration(d)
    }
  }, [knownDuration, setDuration])

  // ── Duration detection + seek index fix ──
  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    const handleMeta = () => {
      if (onLoadedData) onLoadedData()
      tryResolveDuration(el)

      // For blobs/files with Infinity or 0 duration, force the browser
      // to build a seek index by seeking to end and back
      const d = el.duration
      if (!isFinite(d) || d <= 0) {
        el.currentTime = 1e10
        const onSeeked = () => {
          el.removeEventListener('seeked', onSeeked)
          tryResolveDuration(el)
          el.currentTime = 0
        }
        el.addEventListener('seeked', onSeeked)
      }
    }

    if (el.readyState >= 1) {
      handleMeta()
    } else {
      el.addEventListener('loadedmetadata', handleMeta, { once: true })
    }

    // Also listen for durationchange in case it fires later
    const onDurChange = () => tryResolveDuration(el)
    el.addEventListener('durationchange', onDurChange)

    return () => {
      el.removeEventListener('loadedmetadata', handleMeta)
      el.removeEventListener('durationchange', onDurChange)
    }
  }, [src, knownDuration, onLoadedData, tryResolveDuration])

  // ── Smooth rAF progress tracking ──
  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    const tick = () => {
      if (!el.paused && !el.ended) {
        setPlaybackPos(el.currentTime)
        // Keep trying to resolve duration (some browsers reveal it during playback)
        tryResolveDuration(el)
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    const onPlay = () => {
      setIsPlaying(true)
      tryResolveDuration(el)
      rafRef.current = requestAnimationFrame(tick)
    }
    const onPause = () => {
      setIsPlaying(false)
      cancelAnimationFrame(rafRef.current)
      setPlaybackPos(el.currentTime)
    }
    const onEnded = () => {
      setIsPlaying(false)
      cancelAnimationFrame(rafRef.current)
      setPlaybackPos(0)
    }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    return () => {
      cancelAnimationFrame(rafRef.current)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
    }
  }, [src, tryResolveDuration])

  // Reset state when src changes
  useEffect(() => {
    cancelAnimationFrame(rafRef.current)
    setIsPlaying(false)
    setPlaybackPos(0)
    const d = knownDuration || 0
    durRef.current = d
    _setDuration(d)
  }, [src, knownDuration])

  const togglePlayback = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused || el.ended) {
      el.play()
    } else {
      el.pause()
    }
  }, [])

  // Best available duration — check state, then knownDuration, then live el.duration
  const getDur = useCallback(() => {
    if (durRef.current > 0) return durRef.current
    if (knownDuration && knownDuration > 0) return knownDuration
    const el = audioRef.current
    if (el && isFinite(el.duration) && el.duration > 0) return el.duration
    return 0
  }, [knownDuration])

  const effectiveDuration = duration || knownDuration || 0
  const playbackPercent = effectiveDuration > 0
    ? Math.min((playbackPos / effectiveDuration) * 100, 100)
    : 0

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current
    const bar = progressBarRef.current
    if (!el || !bar) return
    // Use best available duration
    const dur = getDur()
    if (dur <= 0) return
    const rect = bar.getBoundingClientRect()
    const pct = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1))
    const seekTo = pct * dur
    // Pause briefly, seek, then resume if was playing
    const wasPlaying = !el.paused
    if (wasPlaying) el.pause()
    try { el.currentTime = seekTo } catch { /* unseekable */ }
    setPlaybackPos(seekTo)
    if (wasPlaying) {
      // Small delay to let the browser process the seek
      setTimeout(() => el.play(), 50)
    }
  }, [getDur])

  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={src}
        preload={preload}
        className="hidden"
        onError={onError}
      />

      {/* Title row */}
      {title && (
        <span className="text-[11px] text-muted-foreground truncate px-0.5">{title}</span>
      )}

      {/* Player row */}
      <div className="flex items-center gap-2">
        {/* Play/Pause button */}
        <button
          onClick={togglePlayback}
          className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center hover:bg-primary/25 transition-colors cursor-pointer shrink-0"
        >
          {isPlaying
            ? <Pause size={12} fill="currentColor" />
            : <Play size={12} fill="currentColor" className="ml-0.5" />
          }
        </button>

        {/* Progress bar */}
        <div
          ref={progressBarRef}
          onMouseDown={handleSeek}
          className="flex-1 h-5 flex items-center cursor-pointer"
        >
          <div className="w-full h-1.5 rounded-full bg-muted-foreground/20 relative overflow-hidden">
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-primary"
              style={{ width: `${playbackPercent}%`, transition: isPlaying ? 'none' : 'width 0.15s ease' }}
            />
          </div>
        </div>

        {/* Time */}
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums shrink-0">
          {fmtTime(playbackPos)}/{fmtTime(effectiveDuration)}
        </span>
      </div>
    </div>
  )
}
