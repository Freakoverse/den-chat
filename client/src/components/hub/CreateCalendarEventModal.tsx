/**
 * CreateCalendarEventModal — Create or edit a hub calendar event (kind 31923)
 *
 * Fields: title, description, summary, start/end date+time (custom pickers),
 * location, image (upload via blossom or paste URL).
 * Times are entered in local device time and stored as UTC unix timestamps.
 *
 * Validation:
 * - Start date cannot be before today
 * - End date cannot be before start date
 * - Start time cannot be before current time (if start date is today)
 * - End time cannot be before start time (if same date)
 * - All validation is re-checked on submit with error messages
 */

import { useState, useMemo, useCallback, useRef } from 'react'
import { X, CalendarPlus, Clock, MapPin, Image as ImageIcon, FileText, CalendarDays, Info, AlertCircle, Loader2, XCircle, Camera } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/DatePicker'
import { TimePicker, format24hPreview } from '@/components/ui/TimePicker'
import { cn } from '@/lib/utils'
import { useUserStore } from '@/stores/userStore'
import { uploadToBlossomServers, blossomServers as blossomServerManager } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import type { CalendarEventData, DecryptedCalendarEvent } from '@/hooks/useCalendar'

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ACCEPTED_IMAGE_EXTENSIONS = '.png,.jpg,.jpeg,.gif,.webp'

function isValidImageFile(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type)
}

function shortServerName(url: string): string {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

interface CreateCalendarEventModalProps {
  onClose: () => void
  onSubmit: (data: CalendarEventData) => Promise<void>
  /** If provided, pre-fills the form for editing */
  editEvent?: DecryptedCalendarEvent
}

function tsToDateValue(ts: number): string {
  const d = new Date(ts * 1000)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function tsToTimeValue(ts: number): string {
  const d = new Date(ts * 1000)
  const hours = String(d.getHours()).padStart(2, '0')
  const mins = String(d.getMinutes()).padStart(2, '0')
  return `${hours}:${mins}`
}

function dateTimeToTs(dateStr: string, timeStr: string): number {
  if (!dateStr) return 0
  const combined = timeStr ? `${dateStr}T${timeStr}` : `${dateStr}T00:00`
  return Math.floor(new Date(combined).getTime() / 1000)
}

function getTodayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function getCurrentTimeStr(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function CreateCalendarEventModal({
  onClose,
  onSubmit,
  editEvent,
}: CreateCalendarEventModalProps) {
  const isEdit = !!editEvent

  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)

  const [title, setTitle] = useState(editEvent?.title || '')
  const [description, setDescription] = useState(editEvent?.description || '')
  const [summary, setSummary] = useState(editEvent?.summary || '')
  const [startDate, setStartDate] = useState(
    editEvent ? tsToDateValue(editEvent.startTimestamp) : ''
  )
  const [startTime, setStartTime] = useState(
    editEvent ? tsToTimeValue(editEvent.startTimestamp) : ''
  )
  const [endDate, setEndDate] = useState(
    editEvent?.endTimestamp ? tsToDateValue(editEvent.endTimestamp) : ''
  )
  const [endTime, setEndTime] = useState(
    editEvent?.endTimestamp ? tsToTimeValue(editEvent.endTimestamp) : ''
  )
  const [location, setLocation] = useState(editEvent?.locations?.[0] || '')
  const [imageUrl, setImageUrl] = useState(editEvent?.image || '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Image upload state
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle')
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [fileSizeWarning, setFileSizeWarning] = useState<{ name: string; limitMb: number } | null>(null)

  const today = getTodayStr()

  const canSubmit = useMemo(
    () => title.trim() && startDate && startTime && !submitting,
    [title, startDate, startTime, submitting]
  )

  // Validate all inputs, returns error string or null
  const validate = useCallback((): string | null => {
    if (!title.trim()) return 'Title is required.'
    if (!startDate) return 'Start date is required.'
    if (!startTime) return 'Start time is required.'

    const todayStr = getTodayStr()
    const nowTimeStr = getCurrentTimeStr()

    // Start date can't be before today
    if (startDate < todayStr) {
      return 'Start date cannot be in the past.'
    }

    // Start time can't be before current time if start date is today
    if (startDate === todayStr && startTime < nowTimeStr) {
      return 'Start time cannot be earlier than the current time today.'
    }

    // End date can't be before start date
    if (endDate && endDate < startDate) {
      return 'End date cannot be before start date.'
    }

    // End time can't be before start time if same date
    if (endDate && endTime) {
      if (endDate === startDate && endTime <= startTime) {
        return 'End time must be after start time on the same date.'
      }
    }

    // If end time is set, end date should be set too
    if (endTime && !endDate) {
      return 'End date is required when end time is set.'
    }

    return null
  }, [title, startDate, startTime, endDate, endTime])

  // ── Image upload ──

  const handleImageUpload = async (file: File) => {
    if (!isValidImageFile(file)) return
    // Enforce upload size limit from settings
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    if (file.size > limitMb * 1024 * 1024) {
      setFileSizeWarning({ name: file.name, limitMb })
      return
    }
    setUploadStatus('uploading')
    setUploadProgress(null)
    try {
      const buffer = await file.arrayBuffer()
      const data = new Uint8Array(buffer)
      const { hash } = await uploadToBlossomServers(
        data, signer, privateKey, undefined, file.type,
        (p) => setUploadProgress({ ...p }),
        () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal },
      )
      const serverUrl = blossomServerManager.getServers()[0]
      setImageUrl(`${serverUrl}/${hash}`)
      setUploadStatus('success')
    } catch {
      setUploadStatus('error')
    } finally {
      setUploadProgress(null)
      uploadAbortRef.current = null
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file || !isValidImageFile(file)) return
    handleImageUpload(file)
  }

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }

  // ── Submit ──

  const handleSubmit = async () => {
    if (!canSubmit) return

    // Final validation
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setError(null)
    setSubmitting(true)

    try {
      const startTs = dateTimeToTs(startDate, startTime)
      const endTs = endDate && endTime ? dateTimeToTs(endDate, endTime) : undefined

      const data: CalendarEventData = {
        title: title.trim(),
        description: description.trim() || undefined,
        summary: summary.trim() || undefined,
        image: imageUrl.trim() || undefined,
        location: location.trim() || undefined,
        startTimestamp: startTs,
        endTimestamp: endTs,
      }

      await onSubmit(data)
      onClose()
    } catch (err) {
      console.error('[Calendar] Failed to save event:', err)
      setError('Failed to save event. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Clear error when user changes inputs
  const clearError = () => { if (error) setError(null) }

  const start24 = format24hPreview(startTime)
  const end24 = format24hPreview(endTime)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-h-[90vh] bg-card border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <CalendarPlus size={18} className="text-primary" />
            <h3 className="text-base font-semibold text-foreground">
              {isEdit ? 'Edit Event' : 'Create Event'}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-xs text-red-400 leading-relaxed">{error}</p>
            </div>
          )}

          {/* Title */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Title <span className="text-[10px] normal-case text-muted-foreground/50">(mandatory)</span>
            </label>
            <input
              value={title}
              onChange={(e) => { setTitle(e.target.value); clearError() }}
              placeholder="Event name"
              className="w-full px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground outline-none"
              maxLength={200}
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Event details..."
              className="w-full px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none"
              rows={3}
              maxLength={2000}
            />
          </div>

          {/* Date row */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <CalendarDays size={12} /> Date <span className="text-[10px] normal-case text-muted-foreground/50">(mandatory)</span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <span className="text-[10px] text-muted-foreground/70">Start date</span>
                <DatePicker
                  value={startDate}
                  onChange={(v) => {
                    setStartDate(v)
                    clearError()
                    // If end date is before new start date, reset it
                    if (endDate && endDate < v) setEndDate(v)
                    // Default end date to start date if empty
                    if (!endDate) setEndDate(v)
                  }}
                  placeholder="Select start"
                  minDate={today}
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-muted-foreground/70">End date (optional)</span>
                <DatePicker
                  value={endDate}
                  onChange={(v) => { setEndDate(v); clearError() }}
                  placeholder="Select end"
                  minDate={startDate || today}
                />
              </div>
            </div>
          </div>

          {/* Time row */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Clock size={12} /> Time <span className="text-[10px] normal-case text-muted-foreground/50">(mandatory)</span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground/70">Start time</span>
                  {start24 && (
                    <span className="text-[10px] text-muted-foreground/40 font-mono">{start24}</span>
                  )}
                </div>
                <TimePicker
                  value={startTime}
                  onChange={(v) => { setStartTime(v); clearError() }}
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground/70">End time (optional)</span>
                  {end24 && (
                    <span className="text-[10px] text-muted-foreground/40 font-mono">{end24}</span>
                  )}
                </div>
                <TimePicker
                  value={endTime}
                  onChange={(v) => { setEndTime(v); clearError() }}
                />
              </div>
            </div>
            <div className="flex items-start gap-1.5 mt-1">
              <Info size={11} className="text-muted-foreground/40 mt-0.5 shrink-0" />
              <p className="text-[10px] text-muted-foreground/40 leading-relaxed">
                Times are entered in your local device time. The event will be saved in UTC and shown to others in their local time.
              </p>
            </div>
          </div>

          {/* Location */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <MapPin size={12} /> Location
            </label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Address, link, or room name"
              className="w-full px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground outline-none"
              maxLength={500}
            />
          </div>

          {/* Summary */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <FileText size={12} /> Summary
            </label>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Short one-line summary"
              className="w-full px-3 py-2 bg-secondary/50 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground outline-none"
              maxLength={300}
            />
            <p className="text-[10px] text-muted-foreground/40">
              If no summary is provided, the beginning of the description will be used instead.
            </p>
          </div>

          {/* Image */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <ImageIcon size={12} /> Image
            </label>

            {/* Upload area / preview */}
            <div className="relative">
              <button
                type="button"
                onClick={() => { if (uploadStatus !== 'uploading') fileInputRef.current?.click() }}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={cn(
                  'w-full rounded-lg overflow-hidden border-2 border-dashed flex items-center justify-center cursor-pointer group transition-colors',
                  imageUrl ? 'h-32' : 'h-24',
                  dragOver ? 'border-primary bg-primary/10' : imageUrl ? 'border-transparent' : 'border-border hover:border-primary/50'
                )}
              >
                {imageUrl ? (
                  <img src={imageUrl} alt="Event image" className="w-full h-full object-cover" />
                ) : (
                  <div className="flex flex-col items-center gap-1 text-muted-foreground group-hover:text-primary/70 transition-colors">
                    <Camera size={20} />
                    <span className="text-xs">Click or drop an image</span>
                    <span className="text-[10px] text-muted-foreground/40">PNG, JPEG, GIF, WebP</span>
                  </div>
                )}
                {uploadStatus === 'uploading' && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg">
                    <Loader2 size={22} className="animate-spin text-white" />
                  </div>
                )}
                {imageUrl && uploadStatus !== 'uploading' && (
                  <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity rounded-lg ${dragOver ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    <Camera size={18} className="text-white" />
                  </div>
                )}
              </button>
              {imageUrl && uploadStatus !== 'uploading' && (
                <button
                  onClick={(e) => { e.stopPropagation(); setImageUrl(''); setUploadStatus('idle') }}
                  className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded-full hover:bg-black/70 cursor-pointer z-10"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Upload progress */}
            {uploadStatus === 'uploading' && uploadProgress && (
              <div className="flex flex-col gap-0.5 w-full mt-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-amber-400 truncate max-w-[200px]">
                    {shortServerName(uploadProgress.serverUrl)} ({uploadProgress.serverIndex + 1}/{uploadProgress.totalServers})
                  </span>
                  <button
                    onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }}
                    className="text-muted-foreground hover:text-destructive cursor-pointer flex items-center gap-0.5"
                  >
                    <XCircle size={10} /><span className="text-[10px]">Skip</span>
                  </button>
                </div>
                <div className="w-full h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${uploadProgress.percent}%` }} />
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span>{Math.round(uploadProgress.percent)}%</span>
                  <span>{formatSpeed(uploadProgress.speed)}</span>
                </div>
              </div>
            )}

            {/* Upload error */}
            {uploadStatus === 'error' && (
              <p className="text-[10px] text-red-400 mt-0.5">Upload failed. You can try again or paste a URL below.</p>
            )}

            {/* URL input */}
            <div className="flex items-center gap-2 mt-1">
              <label className="text-[10px] text-muted-foreground/60 shrink-0">URL</label>
              <input
                value={imageUrl}
                onChange={(e) => { setImageUrl(e.target.value); setUploadStatus('idle') }}
                placeholder="https://... or upload above"
                className="flex-1 px-2 py-1 bg-secondary/50 border border-border rounded text-xs text-foreground font-mono placeholder:text-muted-foreground/40 outline-none"
                maxLength={500}
              />
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_EXTENSIONS}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleImageUpload(f)
                e.target.value = ''
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting
              ? isEdit
                ? 'Saving...'
                : 'Creating...'
              : isEdit
                ? 'Save Changes'
                : 'Create Event'}
          </Button>
        </div>
      </div>

      {/* File size warning modal */}
      {fileSizeWarning && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center px-2 bg-black/60 backdrop-blur-sm" onClick={() => setFileSizeWarning(null)}>
          <div className="w-[400px] bg-card border border-border rounded-xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <AlertCircle size={18} className="text-amber-500 shrink-0" />
              <h4 className="text-sm font-semibold text-foreground">File Too Large</h4>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                The following file exceeds the {fileSizeWarning.limitMb} MB upload limit and was not added:
              </p>
              <div className="text-xs font-mono text-foreground bg-secondary/50 px-2 py-1 rounded truncate">{fileSizeWarning.name}</div>
              <p className="text-[10px] text-muted-foreground">
                This soft limit improves upload success rates across blossom servers. You can change it in <strong>Settings → Network → Media Upload Limit</strong>.
              </p>
            </div>
            <button onClick={() => setFileSizeWarning(null)} className="w-full h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer">
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
