import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { createProjectWithParcel } from '../lib/data'
import type { Parcel } from '../lib/types'
import { ParcelSearch } from './ParcelSearch'

type ProjectModalProps = {
  isOpen: boolean
  onClose: () => void
  onCreated: (project: { id: string; name: string }) => void
  parcels: Parcel[]
  onLookupComplete: () => Promise<void> | void
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

type SelectedParcelChipProps = {
  parcel: Parcel
  onClear: () => void
}

function SelectedParcelChip({ parcel, onClear }: SelectedParcelChipProps) {
  return (
    <div className="hairline flex items-center justify-between rounded-sm bg-white px-3 py-2">
      <div className="min-w-0">
        <div className="truncate font-sans text-sm text-[var(--color-ink)]">
          {parcel.label ?? (
            <span className="italic text-[var(--color-slate)]">(no label)</span>
          )}
        </div>
        <div className="font-mono text-xs text-[var(--color-slate)]">
          {parcel.source_apn}
          {parcel.zone_district_code ? ` · ${parcel.zone_district_code}` : ''}
        </div>
      </div>
      <button
        type="button"
        aria-label="Clear selected parcel"
        onClick={onClear}
        className="ml-3 shrink-0 p-0.5 text-[var(--color-slate)] hover:text-[var(--color-ink)]"
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  )
}

export function ProjectModal({
  isOpen,
  onClose,
  onCreated,
  parcels,
  onLookupComplete,
}: ProjectModalProps) {
  const [name, setName] = useState('')
  const [parcelId, setParcelId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const id = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(id)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  const selectedParcel = useMemo(
    () => parcels.find((p) => p.id === parcelId) ?? null,
    [parcels, parcelId],
  )

  const trimmedName = name.trim()
  const canSubmit = trimmedName.length > 0 && parcelId != null && !submitting

  async function handleSave() {
    if (!canSubmit || parcelId == null) return
    setSubmitting(true)
    setError(null)
    try {
      const project = await createProjectWithParcel(trimmedName, parcelId)
      onCreated(project)
      onClose()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create project',
      )
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-[var(--color-ink)]/30"
      />

      <div className="relative z-10 w-[min(440px,calc(100vw-2rem))] border border-[var(--color-fog)] bg-[var(--color-canvas)] shadow-[0_2px_24px_-8px_rgba(26,26,26,0.18)]">
        <header className="flex items-start justify-between px-6 pt-5 pb-4">
          <h2
            id="project-modal-title"
            className="font-serif text-lg text-[var(--color-ink)]"
          >
            New Project
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 -mt-0.5 p-1 text-[var(--color-slate)] hover:text-[var(--color-ink)]"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </header>

        <div className="border-t border-[var(--color-fog)] px-6 py-5">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="project-name">Name</FieldLabel>
            <input
              ref={nameInputRef}
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. North Nevada infill"
              autoComplete="off"
              className="hairline w-full rounded-sm bg-white px-3 py-2 font-sans text-sm text-[var(--color-ink)] placeholder:text-[var(--color-slate)]"
            />
          </div>

          <div className="mt-5 space-y-1.5">
            <FieldLabel htmlFor="parcel-search">Parcel</FieldLabel>
            {selectedParcel ? (
              <SelectedParcelChip
                parcel={selectedParcel}
                onClear={() => setParcelId(null)}
              />
            ) : (
              <ParcelSearch
                parcels={parcels}
                selectedParcelId={null}
                onSelect={(id) => setParcelId(id)}
                onLookupComplete={onLookupComplete}
                placeholder="Search APN or address…"
              />
            )}
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
            onClick={onClose}
            className="font-mono text-xs uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSubmit}
            className="font-mono text-xs uppercase tracking-[0.08em] text-[var(--color-accent)] hover:text-[var(--color-accent-soft)] disabled:cursor-not-allowed disabled:text-[var(--color-mist)] disabled:hover:text-[var(--color-mist)]"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}
