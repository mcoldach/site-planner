import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { uploadDocument } from '../lib/data'
import type { JurisdictionRef } from '../lib/types'

type SourceUploadModalProps = {
  isOpen: boolean
  onClose: () => void
  /**
   * The currently-selected jurisdiction from SourcesWorkspace. Inherited (not
   * picked here) so the modal stays focused on the document itself — the
   * mental model is "I'm in El Paso County's sources, upload one".
   */
  jurisdiction: JurisdictionRef | null
  /** Bumps SourcesWorkspace's refreshToken so the list re-fetches. */
  onUploaded: () => void
}

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--color-slate)]"
    >
      {children}
    </label>
  )
}

const TEXT_INPUT_CLASS =
  'hairline w-full rounded-sm bg-white px-3 py-2 font-sans text-sm text-[var(--color-ink)] placeholder:text-[var(--color-mist)]'

export function SourceUploadModal({
  isOpen,
  onClose,
  jurisdiction,
  onUploaded,
}: SourceUploadModalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [version, setVersion] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [codeType, setCodeType] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Reset on open. Mirrors ProjectModal: the modal is a transient surface,
  // not a long-lived form — clearing on open keeps re-opens predictable.
  useEffect(() => {
    if (!isOpen) return
    setFile(null)
    setTitle('')
    setVersion('')
    setEffectiveDate('')
    setSourceUrl('')
    setCodeType('')
    setSubmitting(false)
    setError(null)
    const id = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(id)
  }, [isOpen])

  // Escape closes — but only when we aren't in the middle of an upload. A
  // mid-flight close would orphan the Storage object (we don't roll back),
  // so guarding here keeps the user from accidentally tearing it down.
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, submitting])

  const trimmedTitle = title.trim()
  const canSubmit =
    file != null &&
    trimmedTitle.length > 0 &&
    jurisdiction != null &&
    !submitting

  async function handleSubmit() {
    if (!canSubmit || file == null || jurisdiction == null) return
    setSubmitting(true)
    setError(null)
    try {
      await uploadDocument(jurisdiction.id, file, {
        jurisdictionSlug: jurisdiction.slug,
        title: trimmedTitle,
        version: version.trim() || undefined,
        effectiveDate: effectiveDate || undefined,
        sourceUrl: sourceUrl.trim() || undefined,
        codeType: codeType.trim() || undefined,
      })
      onUploaded()
      onClose()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to upload document',
      )
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="source-upload-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div
        aria-hidden
        onClick={() => {
          if (!submitting) onClose()
        }}
        className="absolute inset-0 bg-[var(--color-ink)]/30"
      />

      <div className="relative z-10 w-[min(520px,calc(100vw-2rem))] border border-[var(--color-fog)] bg-[var(--color-canvas)] shadow-[0_2px_24px_-8px_rgba(26,26,26,0.18)]">
        <header className="flex items-start justify-between px-6 pt-5 pb-4">
          <div>
            <h2
              id="source-upload-title"
              className="font-serif text-lg text-[var(--color-ink)]"
            >
              Upload source
            </h2>
            {jurisdiction ? (
              <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-slate)]">
                FOR · {jurisdiction.name}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              if (!submitting) onClose()
            }}
            disabled={submitting}
            className="-mr-1 -mt-0.5 p-1 text-[var(--color-slate)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </header>

        <div className="border-t border-[var(--color-fog)] px-6 py-5">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="source-file">File</FieldLabel>
            <input
              id="source-file"
              type="file"
              accept="application/pdf"
              disabled={submitting}
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null
                setFile(next)
              }}
              className="block w-full text-[13px] text-[var(--color-ink)] file:mr-3 file:border-0 file:bg-[var(--color-paper)] file:px-3 file:py-1.5 file:font-mono file:text-[11px] file:uppercase file:tracking-[0.08em] file:text-[var(--color-slate)] hover:file:text-[var(--color-ink)]"
            />
          </div>

          <div className="mt-5 space-y-1.5">
            <FieldLabel htmlFor="source-title">Title</FieldLabel>
            <input
              ref={titleInputRef}
              id="source-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="El Paso County Land Development Code"
              autoComplete="off"
              disabled={submitting}
              className={TEXT_INPUT_CLASS}
            />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-version">Version</FieldLabel>
              <input
                id="source-version"
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="2024-03 amendment"
                autoComplete="off"
                disabled={submitting}
                className={TEXT_INPUT_CLASS}
              />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-effective-date">
                Effective date
              </FieldLabel>
              <input
                id="source-effective-date"
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
                disabled={submitting}
                className={TEXT_INPUT_CLASS}
              />
            </div>
          </div>

          <div className="mt-5 space-y-1.5">
            <FieldLabel htmlFor="source-url">Source URL</FieldLabel>
            <input
              id="source-url"
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://example.gov/codes/land-use"
              autoComplete="off"
              disabled={submitting}
              className={TEXT_INPUT_CLASS}
            />
          </div>

          <div className="mt-5 space-y-1.5">
            <FieldLabel htmlFor="source-code-type">Code type</FieldLabel>
            <input
              id="source-code-type"
              type="text"
              value={codeType}
              onChange={(e) => setCodeType(e.target.value)}
              placeholder="ordinance, code, master_plan…"
              autoComplete="off"
              disabled={submitting}
              className={TEXT_INPUT_CLASS}
            />
          </div>

          {error ? (
            <p className="mt-4 font-mono text-xs text-[var(--color-ink)]">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-5 border-t border-[var(--color-fog)] bg-[var(--color-paper)] px-6 py-3">
          <button
            type="button"
            onClick={() => {
              if (!submitting) onClose()
            }}
            disabled={submitting}
            className="font-mono text-xs uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="font-mono text-xs uppercase tracking-[0.08em] text-[var(--color-accent)] hover:text-[var(--color-accent-soft)] disabled:cursor-not-allowed disabled:text-[var(--color-mist)] disabled:hover:text-[var(--color-mist)]"
          >
            {submitting ? 'Uploading…' : 'Upload'}
          </button>
        </footer>
      </div>
    </div>
  )
}
