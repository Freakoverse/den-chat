/**
 * animatedImage — detect whether an image's bytes are ANIMATED (vs a single static frame).
 *
 * Used to decide whether a sent image is "GIF-like" enough to offer the "add to GIF favorites"
 * action: an animated GIF or animated WebP qualifies, a static GIF/WebP (or any other still
 * image) does not. Detection is header/marker based and only needs the first few KB of the file.
 */

/** Find an ASCII marker within a byte range. Returns the index or -1. */
function indexOfAscii(buf: Uint8Array, marker: string, start = 0, end = buf.length): number {
  const limit = Math.min(end, buf.length) - marker.length
  for (let i = start; i <= limit; i++) {
    let hit = true
    for (let j = 0; j < marker.length; j++) {
      if (buf[i + j] !== marker.charCodeAt(j)) { hit = false; break }
    }
    if (hit) return i
  }
  return -1
}

/**
 * Decide whether the given bytes are an animated GIF or animated WebP.
 * Only the first chunk of the file is needed, so callers may pass a truncated buffer.
 * Returns false for static images, unknown formats, or too-short buffers.
 */
export function isAnimatedImageBytes(buf: Uint8Array): boolean {
  if (buf.length < 12) return false

  // ── WebP: "RIFF"...."WEBP" container ──
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // "RIFF"
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // "WEBP"
  ) {
    // Extended format "VP8X" is the only one that can animate; its flags byte (payload byte 0,
    // i.e. offset 20) has the animation bit (0x02). The ANIM chunk that follows is a second,
    // unambiguous signal — check both.
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) { // "VP8X"
      if (buf.length > 20 && (buf[20] & 0x02) !== 0) return true
    }
    return indexOfAscii(buf, 'ANIM', 12, 128) !== -1
  }

  // ── GIF: "GIF87a" / "GIF89a" ──
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) { // "GIF"
    // GIF87a predates animation entirely.
    if (buf[4] === 0x37) return false // '7' in "GIF87a"
    // The NETSCAPE2.0 application extension is the loop-control block every animation encoder
    // emits; it appears early (right after the global color table), so a small buffer finds it.
    if (indexOfAscii(buf, 'NETSCAPE2.0', 6) !== -1) return true
    // Fallback: 2+ Graphic Control Extension blocks (0x21 0xF9) means 2+ timed frames.
    let gce = 0
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === 0x21 && buf[i + 1] === 0xf9) { gce++; if (gce >= 2) return true }
    }
    return false
  }

  return false
}

/** Read only the leading bytes of a Blob and run animation detection. */
export async function isAnimatedImageBlob(blob: Blob, maxBytes = 16384): Promise<boolean> {
  try {
    const head = blob.size > maxBytes ? blob.slice(0, maxBytes) : blob
    const buf = new Uint8Array(await head.arrayBuffer())
    return isAnimatedImageBytes(buf)
  } catch {
    return false
  }
}
