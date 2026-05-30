/**
 * useVoiceRecorder — Browser-native voice recording hook
 *
 * Uses MediaRecorder + Web Audio AnalyserNode for recording and real-time
 * waveform visualization. Zero external dependencies.
 *
 * Output format: WebM/Opus (Chrome/Edge), OGG/Opus (Firefox), or MP4 (Safari)
 * at a configurable bitrate (default 32kbps — ~120KB for 30 seconds).
 */

import { useState, useRef, useCallback, useEffect } from 'react'

export type VoiceRecorderState = 'idle' | 'recording' | 'recorded'

export interface UseVoiceRecorderOptions {
  /** Maximum recording duration in seconds (auto-stops) */
  maxDurationSec: number
  /** Audio bitrate in bits/second (default 32000 = 32kbps Opus) */
  audioBitrate: number
}

export interface UseVoiceRecorderReturn {
  /** Current recording state */
  state: VoiceRecorderState
  /** Elapsed recording time in seconds */
  elapsedSec: number
  /** Real-time waveform amplitude data (0-255 per bin) for visualization */
  analyserData: Uint8Array
  /** Final recorded audio blob */
  audioBlob: Blob | null
  /** Object URL for playback of recorded audio */
  audioUrl: string | null
  /** Error message if mic access failed */
  error: string | null

  /** Request mic permission and start recording */
  startRecording: () => Promise<void>
  /** Stop recording (produces audioBlob) */
  stopRecording: () => void
  /** Discard recorded audio and reset to idle */
  discard: () => void
}

/** Pick the best supported MIME type for audio recording */
function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ]
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return '' // let MediaRecorder use its default
}

export function useVoiceRecorder({
  maxDurationSec,
  audioBitrate,
}: UseVoiceRecorderOptions): UseVoiceRecorderReturn {
  const [state, setState] = useState<VoiceRecorderState>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [analyserData, setAnalyserData] = useState<Uint8Array>(() => new Uint8Array(64))
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Refs for cleanup
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number>(0)
  const startTimeRef = useRef<number>(0)
  const timerFrameRef = useRef<number>(0)
  const chunksRef = useRef<Blob[]>([])
  const stateRef = useRef<VoiceRecorderState>('idle')

  // Keep stateRef in sync — set synchronously at each transition point
  // (useEffect is too late for rAF loops that check it on the first frame)
  const setStateAndRef = useCallback((s: VoiceRecorderState) => {
    stateRef.current = s
    setState(s)
  }, [])

  /** Cleanup all resources */
  const cleanup = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    if (timerFrameRef.current) cancelAnimationFrame(timerFrameRef.current)
    animFrameRef.current = 0
    timerFrameRef.current = 0

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop() } catch { /* already stopped */ }
    }
    mediaRecorderRef.current = null

    // Close audio context
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close() } catch { /* ignore */ }
      audioCtxRef.current = null
    }
    analyserRef.current = null

    // Stop all mic tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }

    chunksRef.current = []
  }, [])

  /** Cleanup on unmount */
  useEffect(() => {
    return () => {
      cleanup()
      // Revoke any lingering object URL
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /** Pump analyser data into state via rAF loop */
  const startAnalyserLoop = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    let frameCount = 0
    const loop = () => {
      if (stateRef.current !== 'recording') return
      frameCount++
      // Throttle to every 3rd frame (~20fps) to reduce React re-renders.
      // Chrome struggles with 60fps re-renders of 32 inline-styled bars.
      if (frameCount % 3 === 0) {
        analyser.getByteFrequencyData(dataArray)
        setAnalyserData(new Uint8Array(dataArray))
      }
      animFrameRef.current = requestAnimationFrame(loop)
    }
    animFrameRef.current = requestAnimationFrame(loop)
  }, [])

  /** Timer loop — updates elapsed time via rAF */
  const startTimerLoop = useCallback(() => {
    const loop = () => {
      if (stateRef.current !== 'recording') return
      const elapsed = (performance.now() - startTimeRef.current) / 1000
      setElapsedSec(elapsed)

      // Auto-stop at max duration
      if (elapsed >= maxDurationSec) {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop()
        }
        return
      }
      timerFrameRef.current = requestAnimationFrame(loop)
    }
    timerFrameRef.current = requestAnimationFrame(loop)
  }, [maxDurationSec])

  const startRecording = useCallback(async () => {
    // Discard previous recording if any
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
      setAudioUrl(null)
    }
    setAudioBlob(null)
    setError(null)
    setElapsedSec(0)
    cleanup()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Set up Web Audio analyser for waveform visualization
      const audioCtx = new AudioContext()
      audioCtxRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 128 // 64 frequency bins — enough for a smooth waveform
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      analyserRef.current = analyser

      // Set up MediaRecorder
      const mimeType = pickMimeType()
      const options: MediaRecorderOptions = {
        audioBitsPerSecond: audioBitrate,
      }
      if (mimeType) options.mimeType = mimeType

      const recorder = new MediaRecorder(stream, options)
      mediaRecorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        const rawBlob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' })

        // Finalize elapsed time
        const finalElapsed = Math.min((performance.now() - startTimeRef.current) / 1000, maxDurationSec)
        setElapsedSec(finalElapsed)

        // Stop mic tracks (we no longer need them)
        stream.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        // Transcode to WAV — MediaRecorder's WebM/Ogg containers lack cue
        // points and duration metadata, making them unseekable. WAV has a
        // fixed header with known duration and byte-aligned samples, so
        // seeking always works in every browser.
        try {
          const ctx = new AudioContext()
          const arrayBuf = await rawBlob.arrayBuffer()
          const decoded = await ctx.decodeAudioData(arrayBuf)
          ctx.close()

          const wavBlob = encodeWav(decoded)
          const url = URL.createObjectURL(wavBlob)
          setAudioBlob(wavBlob)
          setAudioUrl(url)
        } catch (e) {
          // Fallback: if transcoding fails, use the original blob
          console.warn('[VoiceRecorder] WAV transcode failed, using original:', e)
          const url = URL.createObjectURL(rawBlob)
          setAudioBlob(rawBlob)
          setAudioUrl(url)
        }

        setStateAndRef('recorded')

        // Close recording audio context
        if (audioCtxRef.current) {
          try { audioCtxRef.current.close() } catch { /* ignore */ }
          audioCtxRef.current = null
        }
        analyserRef.current = null
      }

      // Start!
      recorder.start(100) // collect data every 100ms for responsiveness
      startTimeRef.current = performance.now()
      setStateAndRef('recording')
      startAnalyserLoop()
      startTimerLoop()
    } catch (err: any) {
      cleanup()
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        setError('Microphone permission denied. Please allow mic access in your browser/system settings.')
      } else if (err?.name === 'NotFoundError') {
        setError('No microphone found. Please connect a microphone and try again.')
      } else {
        setError(`Recording failed: ${err?.message || 'Unknown error'}`)
      }
    }
  }, [audioBitrate, maxDurationSec, audioUrl, cleanup, startAnalyserLoop, startTimerLoop, setStateAndRef])

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }
    // Cancel loops — onstop handler will finalize
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    if (timerFrameRef.current) cancelAnimationFrame(timerFrameRef.current)
    animFrameRef.current = 0
    timerFrameRef.current = 0
  }, [])

  const discard = useCallback(() => {
    cleanup()
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioBlob(null)
    setAudioUrl(null)
    setElapsedSec(0)
    setError(null)
    setStateAndRef('idle')
    setAnalyserData(new Uint8Array(64))
  }, [audioUrl, cleanup, setStateAndRef])

  return {
    state,
    elapsedSec,
    analyserData,
    audioBlob,
    audioUrl,
    error,
    startRecording,
    stopRecording,
    discard,
  }
}

/**
 * Encode an AudioBuffer as a WAV Blob (mono, 16-bit PCM).
 * WAV format: http://soundfile.sapp.org/doc/WaveFormat/
 *
 * Mixes all channels down to mono if the source is stereo.
 */
function encodeWav(buffer: AudioBuffer): Blob {
  const sampleRate = buffer.sampleRate
  const numChannels = buffer.numberOfChannels
  const length = buffer.length

  // Mix down to mono
  const mono = new Float32Array(length)
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] / numChannels
    }
  }

  // Convert to 16-bit PCM
  const pcm = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  // Build WAV file
  const byteRate = sampleRate * 2 // mono 16-bit = 2 bytes per sample
  const blockAlign = 2 // mono 16-bit
  const dataSize = pcm.byteLength
  const headerSize = 44
  const buf = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(buf)

  // RIFF header
  writeStr(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true) // file size - 8
  writeStr(view, 8, 'WAVE')

  // fmt sub-chunk
  writeStr(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // sub-chunk size (PCM = 16)
  view.setUint16(20, 1, true) // audio format (1 = PCM)
  view.setUint16(22, 1, true) // num channels (mono)
  view.setUint32(24, sampleRate, true) // sample rate
  view.setUint32(28, byteRate, true) // byte rate
  view.setUint16(32, blockAlign, true) // block align
  view.setUint16(34, 16, true) // bits per sample

  // data sub-chunk
  writeStr(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Write PCM samples
  const output = new Int16Array(buf, headerSize)
  output.set(pcm)

  return new Blob([buf], { type: 'audio/wav' })
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
