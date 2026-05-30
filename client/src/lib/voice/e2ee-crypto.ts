/**
 * E2EE Crypto — Frame-level encryption for voice/video calls
 *
 * Uses AES-128-GCM to encrypt individual media frames via WebRTC Encoded Transforms.
 * The encryption key is derived from the hub secret using HKDF-SHA256,
 * so only hub members can decrypt the media.
 *
 * Supports TWO browser APIs:
 *   - Chromium: `createEncodedStreams()` — inline TransformStream in main thread
 *   - Safari/WebKit: `RTCRtpScriptTransform` — dedicated Worker
 *
 * Frame format:  [IV (12 bytes)] [encrypted payload] [GCM auth tag (16 bytes)]
 *
 * Key rotation: Option A — key is derived once at join time from hub secret + epoch.
 * If the epoch rotates mid-call, the active call continues with the old key.
 * The new key takes effect on the next call.
 */

import { deriveKey } from '@/lib/crypto/hkdf'

// ─── Feature Detection ─────────────────────────────────────────

/** Which Encoded Transforms API is available, or false if none */
export type E2EESupport = 'encodedStreams' | 'scriptTransform' | false

/**
 * Detect which E2EE API the browser supports.
 *
 * - 'scriptTransform': Chrome 117+, Firefox 132+, Safari 15.4+ (modern standard)
 * - 'encodedStreams': Legacy Chromium (createEncodedStreams, deprecated)
 * - false: Very old browsers without any Encoded Transforms support
 *
 * Since October 2025, RTCRtpScriptTransform works in ALL major browsers.
 * The legacy createEncodedStreams path is kept as a fallback for older Chromium.
 */
export function getE2EESupport(): E2EESupport {
  // Prefer the modern standard API (works in Chrome, Firefox, Safari)
  if (typeof RTCRtpScriptTransform !== 'undefined') {
    return 'scriptTransform'
  }
  // Legacy fallback for older Chromium
  if (
    typeof RTCRtpSender !== 'undefined' &&
    'createEncodedStreams' in RTCRtpSender.prototype
  ) {
    return 'encodedStreams'
  }
  return false
}

/** Simple boolean check — true if ANY E2EE path is available */
export function supportsE2EE(): boolean {
  return getE2EESupport() !== false
}

// ─── Key Derivation ─────────────────────────────────────────────

export interface E2EEKeyMaterial {
  /** CryptoKey for main-thread inline transforms (Chromium) */
  cryptoKey: CryptoKey
  /** Raw 16-byte key for transferring to Worker (Safari) */
  rawKeyBytes: Uint8Array
}

/**
 * Derive an AES-128-GCM key for E2EE from the hub secret.
 *
 * @param hubSecretBytes - The 32-byte hub secret
 * @param epoch - Current hub epoch (changes when members are added/removed)
 * @returns Both CryptoKey and raw bytes for cross-context use
 */
export async function deriveE2EEKey(
  hubSecretBytes: Uint8Array,
  epoch: number,
): Promise<E2EEKeyMaterial> {
  // Derive a 16-byte key using HKDF with voice-e2ee domain separation
  const rawKey = deriveKey(hubSecretBytes, `voice-e2ee:epoch:${epoch}`)
  const rawKeyBytes = rawKey.slice(0, 16)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKeyBytes,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt', 'decrypt'],
  )

  return { cryptoKey, rawKeyBytes: new Uint8Array(rawKeyBytes) }
}

// ─── Frame Encryption (main thread — legacy Chromium path) ──────

const IV_LENGTH = 12
const TAG_LENGTH = 16 // AES-GCM auth tag

/**
 * Get the number of unencrypted header bytes for a video frame.
 * VP8: 10 bytes for key frames, 3 bytes for inter frames.
 * These bytes must stay cleartext so the SFU can inspect frame metadata.
 */
function getVideoHeaderSize(data: Uint8Array): number {
  if (data.byteLength < 3) return 0
  const isKeyFrame = (data[0] & 0x01) === 0
  if (isKeyFrame && data.byteLength >= 10) return 10
  return 3
}

/**
 * Encrypt a media frame's payload, preserving video codec headers.
 * Output format: [unencrypted header] [IV (12 bytes)] [encrypted payload + GCM tag]
 */
export async function encryptFrame(
  key: CryptoKey,
  encodedFrame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
  controller: TransformStreamDefaultController,
): Promise<void> {
  const data = new Uint8Array(encodedFrame.data)
  if (data.byteLength === 0) {
    controller.enqueue(encodedFrame)
    return
  }

  // For video frames, preserve codec header bytes
  const isVideo = 'type' in encodedFrame
  const headerSize = isVideo ? getVideoHeaderSize(data) : 0
  const header = data.slice(0, headerSize)
  const payload = data.slice(headerSize)

  if (payload.byteLength === 0) {
    controller.enqueue(encodedFrame)
    return
  }

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  try {
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      payload,
    )

    const encryptedBytes = new Uint8Array(encrypted)
    const output = new Uint8Array(headerSize + IV_LENGTH + encryptedBytes.byteLength)
    output.set(header, 0)
    output.set(iv, headerSize)
    output.set(encryptedBytes, headerSize + IV_LENGTH)

    encodedFrame.data = output.buffer
    controller.enqueue(encodedFrame)
  } catch {
    console.warn('[E2EE] encrypt failed, dropping frame')
  }
}

/**
 * Decrypt a media frame's payload, preserving video codec headers.
 * Expects: [unencrypted header] [IV (12 bytes)] [ciphertext + GCM tag]
 */
export async function decryptFrame(
  key: CryptoKey,
  encodedFrame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
  controller: TransformStreamDefaultController,
): Promise<void> {
  const data = new Uint8Array(encodedFrame.data)

  const isVideo = 'type' in encodedFrame
  const headerSize = isVideo ? getVideoHeaderSize(data) : 0

  // Need at least header + IV + some ciphertext
  if (data.byteLength < headerSize + IV_LENGTH + TAG_LENGTH) {
    controller.enqueue(encodedFrame)
    return
  }

  const header = data.slice(0, headerSize)
  const iv = data.slice(headerSize, headerSize + IV_LENGTH)
  const ciphertext = data.slice(headerSize + IV_LENGTH)

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    )

    const decryptedBytes = new Uint8Array(decrypted)
    const output = new Uint8Array(headerSize + decryptedBytes.byteLength)
    output.set(header, 0)
    output.set(decryptedBytes, headerSize)

    encodedFrame.data = output.buffer
    controller.enqueue(encodedFrame)
  } catch {
    // Decryption failed — drop frame
  }
}

// ─── Per-Transform Worker Management ────────────────────────────

// Track all active Workers so we can terminate them on disconnect
const activeWorkers: Worker[] = []

/**
 * Create a new dedicated Worker for a single RTCRtpScriptTransform.
 * Each transform gets its own Worker to avoid shared-state issues.
 * The key bytes are passed through RTCRtpScriptTransform options,
 * NOT through postMessage — this eliminates race conditions.
 */
function createE2EEWorker(): Worker {
  const worker = new Worker(
    new URL('./e2ee-worker.ts', import.meta.url),
  )
  activeWorkers.push(worker)
  return worker
}

/**
 * Terminate all active E2EE Workers.
 * Call this when leaving a voice channel to clean up resources.
 */
export function cleanupE2EEWorkers(): void {
  for (const worker of activeWorkers) {
    worker.terminate()
  }
  activeWorkers.length = 0
  console.log('[E2EE] All Workers terminated')
}

// ─── Transform Attachment ───────────────────────────────────────

/**
 * Attach encryption transforms to an RTCRtpSender.
 * Automatically picks the right API:
 *   - Modern (Chrome/Firefox/Safari): RTCRtpScriptTransform via dedicated Worker
 *   - Legacy Chromium: inline TransformStream via createEncodedStreams()
 */
export function attachSenderEncryption(
  sender: RTCRtpSender,
  key: CryptoKey,
  rawKeyBytes?: Uint8Array,
): void {
  const support = getE2EESupport()

  if (support === 'scriptTransform' && rawKeyBytes) {
    // Modern standard path — key passed directly through constructor options
    try {
      const worker = createE2EEWorker()
      sender.transform = new RTCRtpScriptTransform(worker, {
        operation: 'encrypt',
        keyBytes: Array.from(rawKeyBytes),
      })
      console.log('[E2EE] Sender encryption attached (RTCRtpScriptTransform)')
    } catch (err) {
      console.warn('[E2EE] Failed to attach sender encryption (scriptTransform):', err)
    }
  } else if (support === 'encodedStreams') {
    // Legacy Chromium fallback — inline TransformStream
    try {
      // @ts-expect-error — createEncodedStreams is a Chromium extension
      const senderStreams = sender.createEncodedStreams()
      const transformStream = new TransformStream({
        transform: (frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller: TransformStreamDefaultController) => {
          return encryptFrame(key, frame, controller)
        },
      })
      senderStreams.readable
        .pipeThrough(transformStream)
        .pipeTo(senderStreams.writable)
      console.log('[E2EE] Sender encryption attached (createEncodedStreams)')
    } catch (err) {
      console.warn('[E2EE] Failed to attach sender encryption (encodedStreams):', err)
    }
  }
}

/**
 * Attach decryption transforms to an RTCRtpReceiver.
 * Automatically picks the right API:
 *   - Modern (Chrome/Firefox/Safari): RTCRtpScriptTransform via dedicated Worker
 *   - Legacy Chromium: inline TransformStream via createEncodedStreams()
 */
export function attachReceiverDecryption(
  receiver: RTCRtpReceiver,
  key: CryptoKey,
  rawKeyBytes?: Uint8Array,
): void {
  const support = getE2EESupport()

  if (support === 'scriptTransform' && rawKeyBytes) {
    // Modern standard path — key passed directly through constructor options
    try {
      const worker = createE2EEWorker()
      receiver.transform = new RTCRtpScriptTransform(worker, {
        operation: 'decrypt',
        keyBytes: Array.from(rawKeyBytes),
      })
      console.log('[E2EE] Receiver decryption attached (RTCRtpScriptTransform)')
    } catch (err) {
      console.warn('[E2EE] Failed to attach receiver decryption (scriptTransform):', err)
    }
  } else if (support === 'encodedStreams') {
    // Legacy Chromium fallback
    try {
      // @ts-expect-error — createEncodedStreams is a Chromium extension
      const receiverStreams = receiver.createEncodedStreams()
      const transformStream = new TransformStream({
        transform: (frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller: TransformStreamDefaultController) => {
          return decryptFrame(key, frame, controller)
        },
      })
      receiverStreams.readable
        .pipeThrough(transformStream)
        .pipeTo(receiverStreams.writable)
      console.log('[E2EE] Receiver decryption attached (createEncodedStreams)')
    } catch (err) {
      console.warn('[E2EE] Failed to attach receiver decryption (encodedStreams):', err)
    }
  }
}
