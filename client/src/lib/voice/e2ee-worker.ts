/**
 * E2EE Worker — WebRTC frame encryption/decryption
 *
 * Each RTCRtpScriptTransform gets its own dedicated Worker instance.
 * The AES-128-GCM key bytes are passed directly through the
 * RTCRtpScriptTransform constructor options.
 *
 * Frame format:
 *   [unencrypted header (codec-specific)] [IV (12 bytes)] [encrypted payload + GCM tag]
 *
 * For video frames, the codec header bytes (VP8: 1-10 bytes, VP9: 1-3 bytes,
 * H.264: 1-2 bytes) are left unencrypted so the SFU can still inspect frame
 * metadata (key frame detection, layer info) for proper routing without being
 * able to decrypt the actual video content.
 *
 * For audio frames, the entire payload is encrypted (Opus has no header that
 * the SFU needs to inspect).
 */

const IV_LENGTH = 12

// ─── Codec Header Detection ─────────────────────────────────────

/**
 * Determine how many bytes at the start of an encoded video frame must
 * remain unencrypted for the SFU/decoder to function properly.
 *
 * VP8 frame header:
 *   - First byte bit 0 (frame_type): 0 = key frame, 1 = inter frame
 *   - Key frames have a 10-byte uncompressed header
 *   - Inter frames have a 3-byte partition header (minimum)
 *
 * VP9, H.264, AV1: use conservative 1-byte skip (enough for SFU routing)
 *
 * Reference: RFC 6386 §9.1 (VP8 bitstream format)
 */
function getVideoHeaderSize(data: Uint8Array): number {
  if (data.byteLength < 1) return 0

  // VP9: the uncompressed header begins with frame_marker == 0b10 in the top two
  // bits of byte 0. Keep 1 byte cleartext (frame marker + type bits). The
  // encrypt/decrypt round-trip is symmetric — both sides read this same preserved
  // byte — so the frame is reconstructed exactly on decrypt, and the SFU routes
  // via the RTP payload descriptor (added after this transform), not the frame body.
  if ((data[0] & 0xc0) === 0x80) return 1

  // VP8: bit 0 of byte 0 is the frame type (0 = key, 1 = inter). Key frames carry a
  // 10-byte uncompressed header; inter frames a 3-byte partition header.
  if (data.byteLength < 3) return 0
  const isKeyFrame = (data[0] & 0x01) === 0
  if (isKeyFrame && data.byteLength >= 10) return 10
  return 3
}

// ─── Frame Encryption ───────────────────────────────────────────

async function encryptFrame(
  key: CryptoKey,
  frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
  controller: TransformStreamDefaultController,
): Promise<void> {
  const data = new Uint8Array(frame.data)
  if (data.byteLength === 0) {
    controller.enqueue(frame)
    return
  }

  // For video, skip codec header bytes; for audio, encrypt everything
  const isVideo = 'type' in frame // RTCEncodedVideoFrame has a 'type' property
  const headerSize = isVideo ? getVideoHeaderSize(data) : 0
  const header = data.slice(0, headerSize)
  const payload = data.slice(headerSize)

  if (payload.byteLength === 0) {
    // Nothing to encrypt (header-only frame), pass through
    controller.enqueue(frame)
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
    // Output: [unencrypted header] [IV] [encrypted payload + GCM tag]
    const output = new Uint8Array(headerSize + IV_LENGTH + encryptedBytes.byteLength)
    output.set(header, 0)
    output.set(iv, headerSize)
    output.set(encryptedBytes, headerSize + IV_LENGTH)

    frame.data = output.buffer.slice(0)
    controller.enqueue(frame)
  } catch {
    // Drop frame on error — never send unencrypted
  }
}

async function decryptFrame(
  key: CryptoKey,
  frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
  controller: TransformStreamDefaultController,
): Promise<void> {
  const data = new Uint8Array(frame.data)

  const isVideo = 'type' in frame
  const headerSize = isVideo ? getVideoHeaderSize(data) : 0

  // Need at least header + IV + some ciphertext
  if (data.byteLength < headerSize + IV_LENGTH + 1) {
    // Too short to be encrypted — pass through
    controller.enqueue(frame)
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

    // Reassemble: [header] [decrypted payload]
    const decryptedBytes = new Uint8Array(decrypted)
    const output = new Uint8Array(headerSize + decryptedBytes.byteLength)
    output.set(header, 0)
    output.set(decryptedBytes, headerSize)

    frame.data = output.buffer.slice(0)
    controller.enqueue(frame)
  } catch {
    // Decryption failed — drop frame (wrong key or corrupted)
  }
}

// ─── Key Management ─────────────────────────────────────────────

// Module-level current key. Each Worker instance handles exactly ONE transform
// (createE2EEWorker() spins up a dedicated Worker per sender/receiver), so a single
// module-level key is unambiguous. The transform reads THIS variable on every frame,
// so a mid-call re-key (a kick/ban rotating the epoch) can swap it live via a 'rekey'
// message without re-attaching the transform.
let currentKey: CryptoKey | null = null

async function importAesKey(keyBytesArray: number[] | undefined): Promise<CryptoKey | null> {
  if (!keyBytesArray || keyBytesArray.length === 0) return null
  try {
    return await crypto.subtle.importKey(
      'raw',
      new Uint8Array(keyBytesArray),
      { name: 'AES-GCM', length: 128 },
      false,
      ['encrypt', 'decrypt'],
    )
  } catch (err) {
    console.error('[E2EE Worker] Failed to import key:', err)
    return null
  }
}

// Live re-key: a rotation posts the new key bytes so existing transforms pick it up
// on their next frame. Ordering is safe — transforms are attached (rtctransform fires)
// at join/track-add, well before any rotation, so this never clobbers a fresh attach.
addEventListener('message', async (event: MessageEvent) => {
  if (event.data?.type === 'rekey') {
    const k = await importAesKey(event.data.keyBytes)
    if (k) {
      currentKey = k
      console.log('[E2EE Worker] Key rotated on live transform')
    }
  }
})

// ─── RTCRtpScriptTransform Handler ──────────────────────────────

addEventListener('rtctransform', async (event: any) => {
  const transformer = event.transformer
  const options = transformer.options || {}
  const operation: 'encrypt' | 'decrypt' = options.operation || 'encrypt'

  currentKey = await importAesKey(options.keyBytes)
  if (currentKey) console.log(`[E2EE Worker] Key imported — ${operation} transform ready`)

  const { readable, writable } = transformer

  const transformStream = new TransformStream({
    async transform(
      frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
      controller: TransformStreamDefaultController,
    ) {
      const key = currentKey
      if (!key) {
        // No key — pass frame through unmodified
        controller.enqueue(frame)
        return
      }

      if (operation === 'encrypt') {
        await encryptFrame(key, frame, controller)
      } else {
        await decryptFrame(key, frame, controller)
      }
    },
  })

  readable.pipeThrough(transformStream).pipeTo(writable)
})
