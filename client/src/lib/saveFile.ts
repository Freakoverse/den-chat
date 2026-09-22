/**
 * saveFile: hand a file to the user with a "Save as" dialog where the platform has one.
 *
 * Chromium browsers and the Tauri desktop webview on Windows support the File System Access API,
 * which opens a real save dialog and lets the user pick the location. Everywhere else (Firefox,
 * Safari, Android and iOS webviews) the only option is the classic anchor download, which lands in
 * the browser's default download folder. `saveBlobAs` resolves with what happened so callers can
 * treat a cancelled dialog as "not saved" rather than "done".
 */
export type SaveResult = 'saved' | 'cancelled' | 'fallback'

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', json: 'application/json', txt: 'text/plain', gz: 'application/gzip',
}

function extOf(filename: string): string {
  const m = filename.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : ''
}

export function canPickSaveLocation(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

/** Save `blob` as `filename`: a location picker when available, else the default download folder. */
export async function saveBlobAs(blob: Blob, filename: string, description = 'File'): Promise<SaveResult> {
  if (canPickSaveLocation()) {
    try {
      const ext = extOf(filename)
      const mime = blob.type || MIME_BY_EXT[ext] || 'application/octet-stream'
      const accept: Record<string, string[]> = { [mime]: ext ? [`.${ext}`] : [] }
      const handle = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<{ createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }> }> })
        .showSaveFilePicker({ suggestedName: filename, types: [{ description, accept }] })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return 'saved'
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled'
      // Anything else (picker refused in this context, permission issue): fall back to the classic path.
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'fallback'
}

/** Save text (JSON, backups) as a file. */
export function saveTextAs(text: string, filename: string, mime = 'application/json', description = 'File'): Promise<SaveResult> {
  return saveBlobAs(new Blob([text], { type: mime }), filename, description)
}
