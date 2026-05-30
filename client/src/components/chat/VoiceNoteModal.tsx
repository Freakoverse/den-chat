/**
 * VoiceNoteModal — Voice recording modal for hub chat & DMs
 *
 * Features:
 * - Large waveform circle with green amplitude visualization
 * - Circular progress ring that completes over maxDuration
 * - Record / Stop / Re-record / Playback / Attach / Discard controls
 * - Auto-stops at max duration
 * - "Attach" produces a File that plugs into ChatInputBar's addFiles flow
 */

import { useCallback, useRef, useEffect } from 'react'
import { X, Mic, Square, RotateCcw, Paperclip, AlertCircle } from 'lucide-react'
import { CustomAudioPlayer } from '@/components/ui/CustomAudioPlayer'
import { useVoiceRecorder } from '@/hooks/useVoiceRecorder'
import { usePreferencesStore } from '@/stores/preferencesStore'

interface VoiceNoteModalProps {
  /** Called with the recorded File when user clicks "Attach" */
  onAttach: (file: File) => void
  /** Close the modal */
  onClose: () => void
}

/** Format seconds as mm:ss */
function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

/** Get file extension for the recorded MIME type */
function getExtForMime(mime: string): string {
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4')) return 'm4a'
  return 'wav'
}

export function VoiceNoteModal({ onAttach, onClose }: VoiceNoteModalProps) {
  const maxDuration = usePreferencesStore((s) => s.voiceNoteMaxDuration)

  const {
    state,
    elapsedSec,
    analyserData,
    audioBlob,
    audioUrl,
    error,
    startRecording,
    stopRecording,
    discard,
  } = useVoiceRecorder({ maxDurationSec: maxDuration, audioBitrate: 48000 })

  const audioRef = useRef<HTMLAudioElement>(null)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleAttach = useCallback(() => {
    if (!audioBlob) return
    const ext = getExtForMime(audioBlob.type)
    const file = new File([audioBlob], `voice-note-${Date.now()}.${ext}`, {
      type: audioBlob.type,
    })
    onAttach(file)
  }, [audioBlob, onAttach])

  const handleReRecord = useCallback(() => {
    discard()
    startRecording()
  }, [discard, startRecording])

  // ── Waveform circle rendering ──
  const CIRCLE_SIZE = 180
  const CIRCLE_RADIUS = 82
  const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * CIRCLE_RADIUS
  const progress = Math.min(elapsedSec / maxDuration, 1)
  const dashOffset = CIRCLE_CIRCUMFERENCE * (1 - progress)

  // Compute average amplitude for the green glow intensity
  const avgAmplitude = analyserData.length > 0
    ? analyserData.reduce((sum, v) => sum + v, 0) / analyserData.length / 255
    : 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[340px] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Mic size={16} className="text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Voice Note</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-col items-center px-5 py-6 gap-4">
          {/* Error state */}
          {error && (
            <div className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30">
              <AlertCircle size={14} className="text-destructive shrink-0" />
              <p className="text-xs text-destructive leading-tight">{error}</p>
            </div>
          )}

          {/* Waveform Circle */}
          <div className="relative" style={{ width: CIRCLE_SIZE, height: CIRCLE_SIZE }}>
            {/* Background circle */}
            <svg
              width={CIRCLE_SIZE}
              height={CIRCLE_SIZE}
              className="absolute inset-0"
            >
              <circle
                cx={CIRCLE_SIZE / 2}
                cy={CIRCLE_SIZE / 2}
                r={CIRCLE_RADIUS}
                fill="none"
                stroke="hsl(var(--border))"
                strokeWidth="3"
                opacity="0.3"
              />
              {/* Progress ring */}
              {state === 'recording' && (
                <circle
                  cx={CIRCLE_SIZE / 2}
                  cy={CIRCLE_SIZE / 2}
                  r={CIRCLE_RADIUS}
                  fill="none"
                  stroke="hsl(var(--primary))"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={CIRCLE_CIRCUMFERENCE}
                  strokeDashoffset={dashOffset}
                  transform={`rotate(-90 ${CIRCLE_SIZE / 2} ${CIRCLE_SIZE / 2})`}
                  style={{ transition: 'none' }}
                />
              )}
              {/* Completed ring for recorded state */}
              {state === 'recorded' && (
                <circle
                  cx={CIRCLE_SIZE / 2}
                  cy={CIRCLE_SIZE / 2}
                  r={CIRCLE_RADIUS}
                  fill="none"
                  stroke="hsl(var(--primary))"
                  strokeWidth="3"
                  strokeLinecap="round"
                  opacity="0.5"
                />
              )}
            </svg>

            {/* Waveform bars inside circle */}
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{
                filter: state === 'recording' ? `drop-shadow(0 0 ${8 + avgAmplitude * 16}px hsl(142 70% 45% / ${0.2 + avgAmplitude * 0.5}))` : undefined,
              }}
            >
              <div className="flex items-center gap-[2px]" style={{ height: 80 }}>
                {Array.from({ length: 32 }).map((_, i) => {
                  // Sample from analyser data (map 32 bars to the data length)
                  const dataIdx = Math.floor((i / 32) * analyserData.length)
                  const value = state === 'recording' ? (analyserData[dataIdx] || 0) / 255 : 0
                  const minHeight = 3
                  const maxBarHeight = 60
                  const barHeight = minHeight + value * maxBarHeight

                  return (
                    <div
                      key={i}
                      className="rounded-full"
                      style={{
                        width: 3,
                        height: barHeight,
                        backgroundColor: state === 'recording'
                          ? `hsl(142 70% ${35 + value * 30}%)`
                          : state === 'recorded'
                            ? 'hsl(var(--primary) / 0.3)'
                            : 'hsl(var(--muted-foreground) / 0.15)',
                      }}
                    />
                  )
                })}
              </div>
            </div>

            {/* Center icon for idle state */}
            {state === 'idle' && !error && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Mic size={36} className="text-muted-foreground/30" />
              </div>
            )}
          </div>

          {/* Timer */}
          <div className="text-center">
            <span className="text-2xl font-mono font-semibold text-foreground tabular-nums">
              {formatTime(elapsedSec)}
            </span>
            <span className="text-sm font-mono text-muted-foreground ml-1">
              / {formatTime(maxDuration)}
            </span>
          </div>

          {/* Playback (after recording) */}
          {state === 'recorded' && audioUrl && (
            <div className="w-full px-2">
              <CustomAudioPlayer
                src={audioUrl}
                knownDuration={elapsedSec}
                preload="auto"
              />
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-3 mt-1">
            {state === 'idle' && (
              <button
                onClick={startRecording}
                disabled={!!error}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-red-500/20"
              >
                <Mic size={16} />
                Record
              </button>
            )}

            {state === 'recording' && (
              <button
                onClick={stopRecording}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors cursor-pointer shadow-lg shadow-red-500/20 animate-pulse"
              >
                <Square size={14} fill="currentColor" />
                Stop
              </button>
            )}

            {state === 'recorded' && (
              <>
                <button
                  onClick={handleReRecord}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-secondary border border-border text-sm font-medium text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  <RotateCcw size={14} />
                  Re-record
                </button>
                <button
                  onClick={handleAttach}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer shadow-lg shadow-primary/20"
                >
                  <Paperclip size={14} />
                  Attach
                </button>
              </>
            )}
          </div>

          {/* Size estimate */}
          {audioBlob && (
            <p className="text-xs text-muted-foreground">
              {(audioBlob.size / 1024).toFixed(1)} KB · {audioBlob.type.split(';')[0].split('/')[1]?.toUpperCase() || 'AUDIO'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
