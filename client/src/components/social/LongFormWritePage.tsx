/**
 * LongFormWritePage — Article editor for kind:30023 / kind:30024 (draft)
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSocialStore } from '@/stores/socialStore'
import { useUserStore } from '@/stores/userStore'
import { useComposeSettings, ComposeSettingsPanel, ComposeSettingsButton } from '@/components/social/ComposeSettings'
import { uploadToBlossomServers, computeHash } from '@/lib/blossom'
import type { UploadProgress } from '@/lib/blossom'
import { getUploadBlossoms } from '@/stores/postingBehaviourStore'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { BlossomImage } from '@/components/ui/BlossomImage'
import { nip19 } from 'nostr-tools'
import {
  ArrowLeft, Loader2, X, Upload, Check, Plus, Image as ImageIcon,
  Bold, Italic, Strikethrough, Heading1, Heading2, Heading3,
  List as ListIcon, ListOrdered, Link, Code, CodeSquare, Smile,
  Tag as TagIcon, FileIcon, Save, Video, ShieldAlert,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { EmojiPickerPopover } from '@/components/chat/EmojiPickerPopover'

type PendingFile = {
  id: string; file: File; status: 'pending' | 'uploading' | 'success' | 'failed'
  hash?: string; progress?: UploadProgress; previewUrl?: string
}

function formatSpeed(bps: number) {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

function shortServerName(url: string) {
  try { return new URL(url).hostname.replace('www.', '') } catch { return url }
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function LongFormWritePage() {
  const editingNaddr = useSocialStore((s) => s.editingArticleNaddr)
  const goBack = useSocialStore((s) => s.goBack)
  const setActivePage = useSocialStore((s) => s.setActivePage)
  const pubkey = useUserStore((s) => s.pubkey)
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const settings = useComposeSettings(15)

  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [featuredImage, setFeaturedImage] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [isNsfw, setIsNsfw] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [editDTag, setEditDTag] = useState<string | null>(null)
  const [editPublishedAt, setEditPublishedAt] = useState<number | null>(null)
  const [editCreatedAt, setEditCreatedAt] = useState<number | null>(null)
  const [editingDraft, setEditingDraft] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(false)

  // Context-aware back navigation: drafts → drafts page, articles → my articles page
  const handleGoBack = useCallback(() => {
    if (editingDraft) {
      setActivePage('longform-drafts')
    } else if (editDTag) {
      setActivePage('longform-mine')
    } else {
      goBack()
    }
  }, [editingDraft, editDTag, setActivePage, goBack])

  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const emojiButtonRef = useRef<HTMLButtonElement>(null)
  const bodyFileInputRef = useRef<HTMLInputElement>(null)
  const featuredFileInputRef = useRef<HTMLInputElement>(null)

  // Featured image upload state
  const [featuredPreview, setFeaturedPreview] = useState<string | null>(null)
  const [featuredFile, setFeaturedFile] = useState<File | null>(null)
  const [featuredUploading, setFeaturedUploading] = useState(false)
  const [featuredUploadDone, setFeaturedUploadDone] = useState(false)
  const [featuredProgress, setFeaturedProgress] = useState<UploadProgress | null>(null)
  const featuredAbortRef = useRef<AbortController | null>(null)

  // Body file uploads
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [bodySizeWarning, setBodySizeWarning] = useState<{ names: string[]; limitMb: number } | null>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const knownHashesRef = useRef<Set<string>>(new Set())

  // Load existing article for editing
  useEffect(() => {
    if (!editingNaddr) return
    setLoadingEdit(true)
    const load = async () => {
      try {
        let decoded: nip19.AddressPointer
        try {
          const result = nip19.decode(editingNaddr)
          if (result.type !== 'naddr') throw new Error()
          decoded = result.data as nip19.AddressPointer
        } catch {
          setLoadingEdit(false); return
        }
        const events = await fetchEvents({
          kinds: [decoded.kind], authors: [decoded.pubkey],
          '#d': [decoded.identifier], limit: 1,
        })
        if (events.length === 0) { setLoadingEdit(false); return }
        const ev = events.sort((a, b) => b.created_at - a.created_at)[0]
        const t = ev.tags
        setTitle(t.find(x => x[0] === 'title')?.[1] || '')
        setSummary(t.find(x => x[0] === 'summary')?.[1] || '')
        setFeaturedImage(t.find(x => x[0] === 'image')?.[1] || '')
        setVideoUrl(t.find(x => x[0] === 'video')?.[1] || '')
        setTags(t.filter(x => x[0] === 't').map(x => x[1]))
        setIsNsfw(t.some(x => x[0] === 'content-warning'))
        setBody(ev.content)
        setEditDTag(t.find(x => x[0] === 'd')?.[1] || null)
        setEditCreatedAt(ev.created_at)
        setEditingDraft(decoded.kind === 30024)
        const pa = t.find(x => x[0] === 'published_at')?.[1]
        setEditPublishedAt(pa ? parseInt(pa, 10) : ev.created_at)
      } catch (err) { console.error('[LongForm] Edit load failed:', err) }
      finally { setLoadingEdit(false) }
    }
    load()
  }, [editingNaddr])

  // Markdown helpers
  const insertMarkdown = useCallback((prefix: string, suffix = '', placeholder = '') => {
    const ta = bodyRef.current; if (!ta) return
    const start = ta.selectionStart, end = ta.selectionEnd
    const selected = body.substring(start, end), text = selected || placeholder
    setBody(`${body.substring(0, start)}${prefix}${text}${suffix}${body.substring(end)}`)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + prefix.length + text.length + suffix.length
      ta.setSelectionRange(selected ? pos : start + prefix.length, selected ? pos : start + prefix.length + text.length)
    })
  }, [body])

  const insertLinePrefix = useCallback((prefix: string) => {
    const ta = bodyRef.current; if (!ta) return
    const start = ta.selectionStart
    const lineStart = body.lastIndexOf('\n', start - 1) + 1
    setBody(`${body.substring(0, lineStart)}${prefix}${body.substring(lineStart)}`)
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(start + prefix.length, start + prefix.length) })
  }, [body])

  const addTag = (raw: string) => {
    const tag = raw.trim()
    if (tag && !tags.includes(tag)) setTags([...tags, tag])
    setTagInput('')
  }

  // Featured image handlers
  const [featuredSizeWarning, setFeaturedSizeWarning] = useState<string | null>(null)
  const handleFeaturedSelect = useCallback((files: FileList | File[]) => {
    const file = Array.from(files).find(f => f.type.startsWith('image/'))
    if (!file) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    const limitBytes = limitMb * 1024 * 1024
    if (file.size > limitBytes) {
      setFeaturedSizeWarning(`${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) exceeds the ${limitMb} MB upload limit. You can change this in Settings → Network → Media Upload Limit.`)
      return
    }
    setFeaturedSizeWarning(null)
    setFeaturedFile(file)
    setFeaturedPreview(URL.createObjectURL(file))
    setFeaturedUploadDone(false); setFeaturedImage('')
  }, [])

  const handleFeaturedUpload = useCallback(async () => {
    if (!featuredFile) return
    setFeaturedUploading(true)
    setFeaturedProgress(null)
    try {
      const servers = getUploadBlossoms()
      const data = new Uint8Array(await featuredFile.arrayBuffer())
      const { hash } = await uploadToBlossomServers(data, signer, privateKey, servers, featuredFile.type,
        (progress) => setFeaturedProgress({ ...progress }),
        () => { const c = new AbortController(); featuredAbortRef.current = c; return c.signal })
      setFeaturedImage(`${(servers[0] || '').replace(/\/+$/, '')}/${hash}`)
      setFeaturedUploadDone(true)
    } catch { /* failed */ }
    finally { setFeaturedUploading(false); setFeaturedProgress(null) }
  }, [featuredFile, signer, privateKey])

  const clearFeatured = useCallback(() => {
    if (featuredPreview) URL.revokeObjectURL(featuredPreview)
    setFeaturedPreview(null); setFeaturedFile(null); setFeaturedImage(''); setFeaturedUploadDone(false); setFeaturedProgress(null)
  }, [featuredPreview])

  // Body file uploads
  const addBodyFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    const limitMb = Number(localStorage.getItem('den-chat-upload-limit-mb')) || 10
    const limitBytes = limitMb * 1024 * 1024
    const tooLarge = files.filter(f => f.size > limitBytes)
    const allowed = files.filter(f => f.size <= limitBytes)
    if (tooLarge.length > 0) {
      setBodySizeWarning({ names: tooLarge.map(f => f.name), limitMb })
    }
    const newPending: PendingFile[] = []
    for (const file of allowed) {
      const hash = computeHash(new Uint8Array(await file.arrayBuffer()))
      if (knownHashesRef.current.has(hash)) continue
      knownHashesRef.current.add(hash)
      const pf: PendingFile = { id: `file_${Date.now()}_${Math.random().toString(36).slice(2)}`, file, status: 'pending', hash }
      if (file.type.startsWith('image/')) pf.previewUrl = URL.createObjectURL(file)
      newPending.push(pf)
    }
    if (newPending.length) setPendingFiles(prev => [...prev, ...newPending])
  }, [])

  const handleUploadBodyFiles = useCallback(async () => {
    const toUpload = pendingFiles.filter(f => f.status === 'pending' || f.status === 'failed')
    if (!toUpload.length) return
    setIsUploading(true)
    const servers = getUploadBlossoms()
    for (const pf of toUpload) {
      setPendingFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'uploading' as const } : f))
      try {
        const data = new Uint8Array(await pf.file.arrayBuffer())
        const { hash } = await uploadToBlossomServers(data, signer, privateKey, servers, pf.file.type,
          (progress) => setPendingFiles(prev => prev.map(f => f.id === pf.id ? { ...f, progress: { ...progress } } : f)),
          () => { const c = new AbortController(); uploadAbortRef.current = c; return c.signal })
        setPendingFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'success' as const, hash } : f))
        const url = `${(servers[0] || '').replace(/\/+$/, '')}/${hash}`
        const md = pf.file.type.startsWith('image/') ? `![${pf.file.name}](${url})` : `[${pf.file.name}](${url})`
        setBody(prev => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + md + '\n')
      } catch {
        setPendingFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'failed' as const } : f))
      }
    }
    setIsUploading(false)
  }, [pendingFiles, signer, privateKey])

  // Publish (kind:30023) or Save Draft (kind:30024)
  const handlePublish = useCallback(async (asDraft = false) => {
    if (!title.trim() || !pubkey) return
    setPublishing(true)
    setPublishError(null)
    try {
      const identifier = editDTag || crypto.randomUUID()
      // When promoting a draft to article, published_at = now (first real publication)
      // When re-saving draft or editing existing article, carry forward original published_at
      const publishedAt = (editingDraft && !asDraft)
        ? Math.floor(Date.now() / 1000)
        : (editPublishedAt || Math.floor(Date.now() / 1000))
      // Editing a published article: created_at = previous + 1 (keeps chronological position)
      // Publishing a draft (or new article): created_at = now
      const createdAt = (editDTag && editCreatedAt && !editingDraft)
        ? editCreatedAt + 1
        : Math.floor(Date.now() / 1000)

      const eventTags: string[][] = [
        ['d', identifier],
        ['title', title.trim()],
        ...(summary.trim() ? [['summary', summary.trim()]] : []),
        ...(featuredImage ? [['image', featuredImage]] : []),
        ...(videoUrl.trim() ? [['video', videoUrl.trim()]] : []),
        ['published_at', String(publishedAt)],
        ...tags.map(t => ['t', t]),
        ...(isNsfw ? [['content-warning', ''], ['L', 'content-warning']] : []),
      ]

      const unsigned = {
        kind: asDraft ? 30024 : 30023,
        pubkey,
        created_at: createdAt,
        tags: eventTags,
        content: body,
      }

      await settings.publishWithSettings(unsigned)
      // Clean up
      pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl) })
      if (featuredPreview) URL.revokeObjectURL(featuredPreview)
      handleGoBack()
    } catch (err) {
      console.error('[LongForm] Publish failed:', err)
      setPublishError(err instanceof Error ? err.message : 'Failed to publish. Please try again.')
    }
    finally { setPublishing(false) }
  }, [title, summary, body, featuredImage, tags, pubkey, editDTag, editPublishedAt, editCreatedAt, editingDraft, settings, handleGoBack, pendingFiles, featuredPreview, videoUrl, isNsfw])

  const hasPending = pendingFiles.some(f => f.status === 'pending' || f.status === 'uploading') || featuredUploading || (!!featuredFile && !featuredUploadDone && !featuredImage)

  if (loadingEdit) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-muted-foreground" /></div>
  }

  const toolbarItems = [
    { icon: Bold, action: () => insertMarkdown('**', '**', 'bold'), tip: 'Bold' },
    { icon: Italic, action: () => insertMarkdown('*', '*', 'italic'), tip: 'Italic' },
    { icon: Strikethrough, action: () => insertMarkdown('~~', '~~', 'strikethrough'), tip: 'Strikethrough' },
    { icon: Heading1, action: () => insertLinePrefix('# '), tip: 'Heading 1' },
    { icon: Heading2, action: () => insertLinePrefix('## '), tip: 'Heading 2' },
    { icon: Heading3, action: () => insertLinePrefix('### '), tip: 'Heading 3' },
    { icon: ListIcon, action: () => insertLinePrefix('- '), tip: 'Bullet List' },
    { icon: ListOrdered, action: () => insertLinePrefix('1. '), tip: 'Numbered List' },
    { icon: Link, action: () => insertMarkdown('[', '](url)', 'text'), tip: 'Link' },
    { icon: Code, action: () => insertMarkdown('`', '`', 'code'), tip: 'Inline Code' },
    { icon: CodeSquare, action: () => insertMarkdown('```\n', '\n```', 'code'), tip: 'Code Block' },
  ]

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 min-h-12 border-b border-border shrink-0">
        <button onClick={handleGoBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
          <ArrowLeft size={16} />
          Back
        </button>
        <span className="font-semibold text-sm text-foreground">
          {editDTag ? (editingDraft ? 'Edit Draft' : 'Edit Article') : 'Write Article'}
        </span>
        <div className="flex items-center gap-1.5">
          <ComposeSettingsButton open={showSettings} onClick={() => setShowSettings(!showSettings)} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full mx-auto py-4 px-6 space-y-4 max-[1080px]:px-4" style={{ maxWidth: 720 }}>
          {showSettings && (
            <ComposeSettingsPanel settings={settings} />
          )}

          {/* Title */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Title *</label>
            <input type="text" placeholder="Article title" value={title} onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors" />
          </div>

          {/* Summary */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Summary (optional)</label>
            <textarea placeholder="Brief description of your article..." value={summary} onChange={(e) => setSummary(e.target.value)} rows={2}
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors resize-y" />
          </div>

          {/* Featured image */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Featured Image (optional)</label>
            {!featuredPreview && !featuredImage ? (
              <div onClick={() => featuredFileInputRef.current?.click()}
                className="w-full h-36 rounded-lg border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 cursor-pointer hover:border-primary/50 hover:bg-accent/20 transition-colors">
                <ImageIcon size={28} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Click or drag & drop an image</span>
              </div>
            ) : (
              <div className="relative rounded-lg overflow-hidden border border-border">
                <img src={featuredPreview || featuredImage} alt="Featured" className="w-full h-44 object-cover" />
                <button onClick={clearFeatured} className="absolute top-2 right-2 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center cursor-pointer hover:bg-black/80"><X size={12} /></button>
                {featuredFile && !featuredUploadDone && !featuredImage && !featuredUploading && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2.5">
                    <button onClick={handleFeaturedUpload} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 cursor-pointer">
                      <Upload size={13} /> Upload
                    </button>
                  </div>
                )}
                {featuredUploading && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2.5">
                    {featuredProgress ? (
                      <div className="space-y-1">
                        <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden">
                          <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${featuredProgress.percent}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-white/70">
                          <span className="truncate">{shortServerName(featuredProgress.serverUrl)} ({featuredProgress.serverIndex + 1}/{featuredProgress.totalServers})</span>
                          <span className="flex items-center gap-1">
                            {featuredProgress.percent >= 100
                              ? <span className="text-amber-400">Processing...</span>
                              : formatSpeed(featuredProgress.speed)
                            }
                            <button
                              onClick={() => { featuredAbortRef.current?.abort(); featuredAbortRef.current = null }}
                              className="text-white/50 hover:text-white cursor-pointer ml-0.5"
                            >skip</button>
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-white/80"><Loader2 size={14} className="animate-spin" />Uploading...</div>
                    )}
                  </div>
                )}
                {featuredUploadDone && (
                  <div className="absolute bottom-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/80 text-white text-[10px] font-medium"><Check size={10} /> Uploaded</div>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] text-muted-foreground shrink-0">{featuredImage ? 'URL:' : 'Or paste URL:'}</span>
              <input type="text" placeholder="https://..." value={featuredImage} onChange={(e) => setFeaturedImage(e.target.value)}
                className="flex-1 p-2 rounded-lg border border-input bg-background text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40" />
            </div>
            <input ref={featuredFileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { if (e.target.files?.length) handleFeaturedSelect(e.target.files); e.target.value = '' }} />
            {featuredSizeWarning && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                {featuredSizeWarning}
              </div>
            )}
          </div>

          {/* Video URL */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Video (optional)</label>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
              <Video size={13} className="text-muted-foreground shrink-0" />
              <input type="text" placeholder="Paste video URL (mp4, webm, etc.)" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)}
                className="flex-1 p-2 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm" />
              {videoUrl && (
                <button onClick={() => setVideoUrl('')} className="text-muted-foreground hover:text-destructive cursor-pointer"><X size={12} /></button>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">Displayed in the article reader. Cards will still show the featured image.</p>
          </div>

          {/* Tags */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Tags (optional)</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tags.map(tag => (
                <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary text-xs font-medium">
                  {tag}
                  <button onClick={() => setTags(tags.filter(t => t !== tag))} className="hover:text-destructive cursor-pointer"><X size={10} /></button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/60 border border-border focus-within:border-primary/40 transition-colors">
              <TagIcon size={13} className="text-muted-foreground shrink-0" />
              <input type="text" placeholder="Add tag and press Enter..." value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(tagInput) }
                  else if (e.key === 'Backspace' && !tagInput && tags.length > 0) setTags(tags.slice(0, -1))
                }}
                className="flex-1 p-2 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none rounded-sm" />
              <button type="button" onClick={() => addTag(tagInput)} disabled={!tagInput.trim()}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0">
                <Plus size={14} />
              </button>
            </div>
          </div>

          {/* NSFW Toggle */}
          <div>
            <button
              type="button"
              onClick={() => setIsNsfw(!isNsfw)}
              className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-lg border transition-colors cursor-pointer ${
                isNsfw
                  ? 'border-amber-500/40 bg-amber-500/10'
                  : 'border-border bg-secondary/40 hover:bg-secondary/60'
              }`}
            >
              <div className={`w-8 h-5 rounded-full flex items-center transition-colors shrink-0 ${isNsfw ? 'bg-amber-500 justify-end' : 'bg-secondary justify-start'}`}>
                <span className="w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all mx-0.5" />
              </div>
              <ShieldAlert size={14} className={isNsfw ? 'text-amber-500' : 'text-muted-foreground'} />
              <span className={`text-xs font-medium ${isNsfw ? 'text-amber-500' : 'text-muted-foreground'}`}>Mark as NSFW (content warning)</span>
            </button>
          </div>

          {/* Body */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">Body</label>
            <TooltipProvider delayDuration={200}>
              <div className="flex items-center gap-0.5 px-3 py-1.5 bg-secondary/80 border border-border border-b-0 rounded-t-lg flex-wrap">
                {toolbarItems.map(({ icon: Icon, action, tip }) => (
                  <Tooltip key={tip}><TooltipTrigger asChild>
                    <button type="button" onClick={action} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"><Icon size={14} /></button>
                  </TooltipTrigger><TooltipContent side="top" className="text-xs">{tip}</TooltipContent></Tooltip>
                ))}
                <div className="w-px h-4 bg-border/50 mx-1" />
                <Tooltip><TooltipTrigger asChild>
                  <button type="button" onClick={() => bodyFileInputRef.current?.click()} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"><ImageIcon size={14} /></button>
                </TooltipTrigger><TooltipContent side="top" className="text-xs">Insert image</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger asChild>
                  <button ref={emojiButtonRef} type="button" onClick={() => setShowEmoji(!showEmoji)} className="p-1.5 rounded cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"><Smile size={14} /></button>
                </TooltipTrigger><TooltipContent side="top" className="text-xs">Emoji</TooltipContent></Tooltip>
              </div>
            </TooltipProvider>
            {showEmoji && (
              <EmojiPickerPopover anchorRef={emojiButtonRef} onClose={() => setShowEmoji(false)}
                onSelect={(emoji) => { setBody(prev => prev + emoji); setShowEmoji(false); bodyRef.current?.focus() }} />
            )}
            <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const ta = bodyRef.current
                  if (ta) {
                    const start = ta.selectionStart
                    const end = ta.selectionEnd
                    const spaces = '   '
                    const before = body.substring(0, start)
                    const after = body.substring(end)
                    setBody(`${before}${spaces}${after}`)
                    requestAnimationFrame(() => {
                      ta.focus()
                      const pos = start + spaces.length
                      ta.setSelectionRange(pos, pos)
                    })
                  }
                }
              }}
              placeholder="Write your article content in markdown..."
              rows={16} className="w-full px-3 py-2 rounded-b-lg border border-input border-t-0 bg-background text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/40 transition-colors resize-y font-mono" />
            <div className="flex items-center justify-end mt-1">
              <span className="text-[10px] text-muted-foreground">{body.split(/\s+/).filter(Boolean).length} words</span>
            </div>
            <input ref={bodyFileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addBodyFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
            {bodySizeWarning && (
              <div className="flex items-start gap-2 mt-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                <div className="flex-1">
                  <p>
                    The following file{bodySizeWarning.names.length > 1 ? 's exceed' : ' exceeds'} the {bodySizeWarning.limitMb} MB upload limit and {bodySizeWarning.names.length > 1 ? 'were' : 'was'} not added:
                  </p>
                  <p className="font-medium mt-0.5">{bodySizeWarning.names.join(', ')}</p>
                  <p className="text-destructive/70 mt-0.5">You can change this in <strong>Settings → Network → Media Upload Limit</strong>.</p>
                </div>
                <button onClick={() => setBodySizeWarning(null)} className="p-0.5 rounded hover:bg-destructive/20 cursor-pointer shrink-0 mt-0.5">
                  <X size={12} />
                </button>
              </div>
            )}
            {pendingFiles.length > 0 && (
              <div className="flex flex-col gap-2 mt-2">
                <div className="flex gap-2 overflow-x-auto">
                  {pendingFiles.map(pf => (
                    <div key={pf.id} className="flex items-stretch bg-background rounded-lg border border-border min-w-[140px] max-w-[220px] shrink-0">
                      <div className="flex items-center gap-2 flex-1 min-w-0 px-2 py-1.5">
                        {pf.previewUrl ? <img src={pf.previewUrl} alt="" className="w-10 h-10 rounded object-cover shrink-0" /> : (
                          <div className="w-10 h-10 rounded bg-secondary flex items-center justify-center shrink-0"><FileIcon size={18} className="text-muted-foreground" /></div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-foreground truncate">{pf.file.name}</p>
                          <p className="text-[10px] text-muted-foreground">{formatFileSize(pf.file.size)}</p>
                          {/* Upload progress */}
                          {pf.status === 'uploading' && pf.progress && (
                            <div className="mt-0.5">
                              <div className="w-full h-1 rounded-full bg-secondary overflow-hidden">
                                <div className="h-full bg-amber-400 rounded-full transition-all duration-150" style={{ width: `${pf.progress.percent}%` }} />
                              </div>
                              <div className="flex items-center justify-between text-[9px] text-muted-foreground mt-0.5">
                                <span className="truncate">{shortServerName(pf.progress.serverUrl)} ({pf.progress.serverIndex + 1}/{pf.progress.totalServers})</span>
                                <span className="flex items-center gap-1">
                                  {pf.progress.percent >= 100
                                    ? <span className="text-amber-400">Processing...</span>
                                    : formatSpeed(pf.progress.speed)
                                  }
                                  <button
                                    onClick={() => { uploadAbortRef.current?.abort(); uploadAbortRef.current = null }}
                                    className="text-muted-foreground hover:text-destructive cursor-pointer ml-0.5"
                                  >skip</button>
                                </span>
                              </div>
                            </div>
                          )}
                          {pf.status === 'success' && <span className="text-[10px] text-emerald-400">✓ Uploaded</span>}
                          {pf.status === 'failed' && (
                            <button onClick={() => setPendingFiles(prev => prev.map(f => f.id === pf.id ? { ...f, status: 'pending' as const } : f))} className="text-[10px] text-destructive hover:underline cursor-pointer">Failed — retry</button>
                          )}
                        </div>
                      </div>
                      {pf.status !== 'uploading' && (
                        <button onClick={() => setPendingFiles(prev => prev.filter(f => f.id !== pf.id))} className="flex items-center justify-center px-1.5 border-l border-border text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer transition-colors rounded-r-lg">
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  {pendingFiles.some(f => f.status === 'pending' || f.status === 'failed') && !isUploading && (
                    <button onClick={handleUploadBodyFiles} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-primary/50 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 transition-colors cursor-pointer">
                      <Upload size={14} /> Upload {pendingFiles.filter(f => f.status === 'pending' || f.status === 'failed').length} file{pendingFiles.filter(f => f.status === 'pending' || f.status === 'failed').length > 1 ? 's' : ''}
                    </button>
                  )}
                  {isUploading && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground">
                      <Loader2 size={14} className="animate-spin" /> Uploading...
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-border shrink-0">
        {publishError && <span className="text-xs text-red-400 mr-auto">{publishError}</span>}
        <button onClick={handleGoBack} className="px-4 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer">Cancel</button>
        <button onClick={() => handlePublish(true)} disabled={!title.trim() || publishing || hasPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
          <Save size={12} /> Save Draft
        </button>
        <button onClick={() => handlePublish(false)} disabled={!title.trim() || publishing || hasPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
          {publishing && <Loader2 size={12} className="animate-spin" />}
          {editDTag ? (editingDraft ? 'Publish Draft' : 'Update Article') : 'Publish Article'}
        </button>
      </div>
    </div>
  )
}
