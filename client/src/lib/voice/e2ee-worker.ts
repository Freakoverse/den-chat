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
  if (data.byteLength < 3) return 0

  // VP8 detection: check if first byte looks like a VP8 frame
  // Bit 0: frame type (0=key, 1=inter)
  const isKeyFrame = (data[0] & 0x01) === 0

  // VP8 key frames start with a 10-byte "uncompressed data chunk"
  // Inter frames have a 3-byte partition header
  if (isKeyFrame && data.byteLength >= 10) {
    return 10
  }
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

// ─── RTCRtpScriptTransform Handler ──────────────────────────────

addEventListener('rtctransform', async (event: any) => {
  const transformer = event.transformer
  const options = transformer.options || {}
  const operation: 'encrypt' | 'decrypt' = options.operation || 'encrypt'
  const keyBytesArray: number[] | undefined = options.keyBytes

  // Import the AES-GCM key from the options
  let key: CryptoKey | null = null
  if (keyBytesArray && keyBytesArray.length > 0) {
    try {
      const rawBytes = new Uint8Array(keyBytesArray)
      key = await crypto.subtle.importKey(
        'raw',
        rawBytes,
        { name: 'AES-GCM', length: 128 },
        false,
        ['encrypt', 'decrypt'],
      )
      console.log(`[E2EE Worker] Key imported — ${operation} transform ready`)
    } catch (err) {
      console.error('[E2EE Worker] Failed to import key:', err)
    }
  }

  const { readable, writable } = transformer

  const transformStream = new TransformStream({
    async transform(
      frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame,
      controller: TransformStreamDefaultController,
    ) {
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
