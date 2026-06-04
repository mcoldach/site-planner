import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  editClaim,
  fetchClaimsForJurisdiction,
  fetchDocumentsForJurisdiction,
  fetchJurisdictions,
} from '../lib/data'
import type {
  Document,
  IngestStatus,
  JurisdictionRef,
  ReviewClaim,
  ReviewState,
} from '../lib/types'
import { ReviewClaimsList } from './ReviewClaimsList'

type SourcesWorkspaceProps = {
  /**
   * Bumped by the parent after a successful upload so this view refetches
   * the documents list without us needing a callback ref into App. Keeping
   * the refresh signal one-directional matches how ProjectWorkspace handles
   * scheme refreshes.
   */
  refreshToken: number
  /**
   * Lifted up so the upload modal (rendered at App level next to ProjectModal)
   * knows which jurisdiction the upload is "for". The selector still owns
   * the currently-displayed jurisdiction; this is the read-only mirror.
   */
  onJurisdictionChange: (jurisdiction: JurisdictionRef | null) => void
}

type JurisdictionSelectorProps = {
  jurisdictions: JurisdictionRef[]
  selectedId: string | null
  onSelect: (id: string) => void
}

// Custom dropdown patterned on `SchemeSelector` in ProjectWorkspace —
// hairline trigger, ChevronDown affordance, popover list with accent-wash
// hover. We avoid <select> because the eventual richer affordance (slug
// caption under name) is hard to render natively, and the rest of the app
// already standardized on this look.
function JurisdictionSelector({
  jurisdictions,
  selectedId,
  onSelect,
}: JurisdictionSelectorProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const selected =
    jurisdictions.find((j) => j.id === selectedId) ?? jurisdictions[0] ?? null

  useEffect(() => {
    if (!open) return
    const handleMouseDown = (event: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  if (!selected) return null

  return (
    <section
      ref={wrapperRef}
      className="relative w-full max-w-[360px]"
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-slate)]">
        Jurisdiction
      </p>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="hairline mt-1.5 flex w-full items-center justify-between gap-2 rounded-sm bg-[var(--color-canvas)] px-3 py-2 text-left"
      >
        <span className="min-w-0 truncate font-sans text-sm text-[var(--color-ink)]">
          {selected.name}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-[var(--color-slate)] transition-transform ${
            open ? 'rotate-180' : ''
          }`}
          strokeWidth={2}
          aria-hidden
        />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="hairline absolute left-0 right-0 top-full z-20 mt-1 max-h-[260px] overflow-y-auto border bg-[var(--color-canvas)]"
        >
          {jurisdictions.map((j, index) => {
            const isLast = index === jurisdictions.length - 1
            const isSelected = j.id === selected.id
            return (
              <li
                key={j.id}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(j.id)
                  setOpen(false)
                }}
                className={`cursor-pointer px-3 py-2 ${
                  isSelected
                    ? 'bg-[var(--color-accent-wash)]'
                    : 'hover:bg-[var(--color-accent-wash)]'
                } ${isLast ? '' : 'hairline border-b'}`}
              >
                <div className="truncate font-sans text-sm text-[var(--color-ink)]">
                  {j.name}
                </div>
                <div className="font-mono text-[11px] text-[var(--color-slate)]">
                  {j.slug}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

type IngestStatusBadgeProps = {
  status: IngestStatus
}

// Single token per state, kept restrained — mono caps, hairline border,
// no fill. Color carries the meaning: mist for the resting "uploaded"
// state, slate for in-flight processing, accent for ingested (the only
// "success" emphasis in the app), ink for failure. We deliberately avoid
// a saturated red/green to stay in the editorial palette.
function IngestStatusBadge({ status }: IngestStatusBadgeProps) {
  const label = status.toUpperCase()

  let toneClass: string
  if (status === 'uploaded') {
    toneClass = 'border-[var(--color-mist)] text-[var(--color-mist)]'
  } else if (status === 'processing') {
    toneClass = 'border-[var(--color-slate)] text-[var(--color-slate)]'
  } else if (status === 'ingested') {
    toneClass = 'border-[var(--color-accent)] text-[var(--color-accent)]'
  } else {
    toneClass = 'border-[var(--color-ink)] text-[var(--color-ink)]'
  }

  return (
    <span
      className={`inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] ${toneClass}`}
    >
      {label}
    </span>
  )
}

function formatUploadedDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  })
}

type DocumentsListProps = {
  documents: Document[]
}

function DocumentsList({ documents }: DocumentsListProps) {
  if (documents.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center py-24">
        <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-slate)]">
          No sources uploaded for this jurisdiction yet.
        </p>
      </div>
    )
  }

  return (
    <ul className="border-t border-[var(--color-fog)]">
      {documents.map((doc) => (
        <li
          key={doc.id}
          className="border-b border-[var(--color-fog)] px-8 py-4"
        >
          <div className="flex items-start justify-between gap-8">
            <div className="min-w-0 flex-1">
              <p className="font-serif text-base leading-snug text-[var(--color-ink)]">
                {doc.title?.trim() || doc.filename}
              </p>
              <p className="mt-1 truncate font-mono text-[11px] text-[var(--color-slate)]">
                {doc.filename}
                {doc.version ? ` · ${doc.version}` : ''}
                {doc.code_type ? ` · ${doc.code_type}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <IngestStatusBadge status={doc.ingest_status} />
              <p
                className="font-mono text-[11px] text-[var(--color-slate)]"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatUploadedDate(doc.created_at)}
              </p>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function SourcesWorkspace({
  refreshToken,
  onJurisdictionChange,
}: SourcesWorkspaceProps) {
  const [jurisdictions, setJurisdictions] = useState<JurisdictionRef[]>([])
  const [selectedJurisdictionId, setSelectedJurisdictionId] = useState<
    string | null
  >(null)
  const [documents, setDocuments] = useState<Document[]>([])
  const [claims, setClaims] = useState<ReviewClaim[]>([])
  const [claimsToken, setClaimsToken] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchJurisdictions()
      .then((rows) => {
        if (cancelled) return
        setJurisdictions(rows)
        if (rows[0]) setSelectedJurisdictionId(rows[0].id)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(
          e instanceof Error ? e.message : 'Failed to load jurisdictions',
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const selected =
      jurisdictions.find((j) => j.id === selectedJurisdictionId) ?? null
    onJurisdictionChange(selected)
  }, [jurisdictions, selectedJurisdictionId, onJurisdictionChange])

  useEffect(() => {
    if (!selectedJurisdictionId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDocuments([])
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setClaims([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([
      fetchDocumentsForJurisdiction(selectedJurisdictionId),
      fetchClaimsForJurisdiction(selectedJurisdictionId),
    ])
      .then(([docs, claimsRows]) => {
        if (cancelled) return
        setDocuments(docs)
        setClaims(claimsRows)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load data')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedJurisdictionId, refreshToken, claimsToken])

  const handleEditClaim = useCallback(
    async (claimId: string, editNote: string, reviewState: ReviewState) => {
      await editClaim(claimId, editNote, { reviewState })
      setClaimsToken((n) => n + 1)
    },
    [],
  )

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-[var(--color-paper)]">
      <div className="border-b border-[var(--color-fog)] px-8 pb-5 pt-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-slate)]">
          Sources
        </p>
        <h2 className="mt-1 font-serif text-lg text-[var(--color-ink)]">
          Cited reference material
        </h2>
      </div>

      <div className="px-8 py-5">
        <JurisdictionSelector
          jurisdictions={jurisdictions}
          selectedId={selectedJurisdictionId}
          onSelect={setSelectedJurisdictionId}
        />
      </div>

      {error ? (
        <div className="px-8 py-4">
          <p className="font-mono text-xs text-[var(--color-ink)]">{error}</p>
        </div>
      ) : loading && documents.length === 0 ? (
        <div className="px-8 py-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-[var(--color-slate)]">
            Loading…
          </p>
        </div>
      ) : (
        <>
          <DocumentsList documents={documents} />

          {claims.length > 0 ? (
            <div className="border-t border-[var(--color-fog)] px-8 py-6">
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-slate)]">
                Claims
              </p>
              <h3 className="mt-1 font-serif text-base text-[var(--color-ink)]">
                Extracted constraints
              </h3>
              <div className="mt-4">
                <ReviewClaimsList
                  claims={claims}
                  onEdit={handleEditClaim}
                />
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
