import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ParcelContextPanel } from './ParcelContextPanel'
import { fetchProjectContext } from '../lib/data'
import type { Classification, Parcel, ParcelContext } from '../lib/types'

type ProjectWorkspaceProps = {
  projectId: string | null
  onClose: () => void
}

function EmptyState() {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        PROJECTS
      </p>
      <p className="mt-3 font-sans text-sm italic text-[var(--color-slate)]">
        Select a project on the map to open its workspace.
      </p>
    </div>
  )
}

type WorkspaceHeaderProps = {
  name: string
  expanded: boolean
  onClose: () => void
}

function WorkspaceHeader({ name, expanded, onClose }: WorkspaceHeaderProps) {
  return (
    <header className="flex items-start justify-between">
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          PROJECT
        </p>
        <h2
          className={`mt-1 truncate font-serif text-[var(--color-ink)] ${
            expanded ? 'text-2xl' : 'text-lg'
          }`}
        >
          {name}
        </h2>
      </div>
      <button
        type="button"
        aria-label="Close project workspace"
        onClick={onClose}
        className="-mr-1 -mt-0.5 ml-3 shrink-0 p-1 text-[var(--color-slate)] hover:text-[var(--color-ink)]"
      >
        <X className="size-4" strokeWidth={2} />
      </button>
    </header>
  )
}

function currentZoningValue(
  parcel: Parcel,
  classification: Classification,
): string {
  const codes = classification.base_codes.map((b) => b.code)
  if (codes.length > 0) {
    return `Current zoning · ${codes.join(', ')}`
  }
  const fallback = parcel.zone_district_code?.trim()
  return fallback ? `Current zoning · ${fallback}` : 'Current zoning'
}

type ConstraintBasisProps = {
  parcel: Parcel
  classification: Classification
}

// Phase-3 seam: this element is the visual anchor for "what zoning are we
// designing against?". For now it only displays the current-zoning basis and
// is intentionally non-interactive — Phase 3 will swap the value for a
// selector (current vs. hypothetical rezoning) without changing the shell.
function ConstraintBasis({ parcel, classification }: ConstraintBasisProps) {
  return (
    <section>
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        CONSTRAINT BASIS
      </p>
      <div className="hairline mt-2 rounded-sm bg-white px-3 py-2">
        <p className="font-sans text-sm text-[var(--color-ink)]">
          {currentZoningValue(parcel, classification)}
        </p>
      </div>
    </section>
  )
}

// Loaded as a child keyed by projectId so React resets state on selection
// change — keeps the fetch effect free of synchronous setState calls on
// dependency change, which is what the codebase's lint posture rewards.
type LoadedProjectWorkspaceProps = {
  projectId: string
  expanded: boolean
  onClose: () => void
}

function LoadedProjectWorkspace({
  projectId,
  expanded,
  onClose,
}: LoadedProjectWorkspaceProps) {
  const [project, setProject] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [context, setContext] = useState<ParcelContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void fetchProjectContext(projectId)
      .then((data) => {
        if (cancelled) return
        setProject(data.project)
        setContext(data.context)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load project',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [projectId])

  if (loading) {
    return (
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        loading…
      </p>
    )
  }
  if (error) {
    return <p className="text-sm text-[var(--color-slate)]">{error}</p>
  }
  if (!project || !context) return null

  return (
    <>
      <WorkspaceHeader
        name={project.name}
        expanded={expanded}
        onClose={onClose}
      />
      <div className={expanded ? 'mt-7' : 'mt-5'}>
        <ConstraintBasis
          parcel={context.parcel}
          classification={context.classification}
        />
      </div>
      <div className="my-4 border-t border-[var(--color-fog)]" aria-hidden />
      <ParcelContextPanel {...context} />
    </>
  )
}

// Small hairline circular control that toggles docked ⇄ full-cover. Visually
// distinct from the header × (close-workspace) so the two affordances don't
// blur: this is a chevron on the panel's left edge; close is an X in the
// header.
type ExpandToggleProps = {
  expanded: boolean
  onToggle: () => void
  className: string
}

function ExpandToggle({ expanded, onToggle, className }: ExpandToggleProps) {
  const Icon = expanded ? ChevronRight : ChevronLeft
  return (
    <button
      type="button"
      aria-label={expanded ? 'Collapse workspace to docked' : 'Expand workspace'}
      aria-expanded={expanded}
      onClick={onToggle}
      className={`flex size-7 items-center justify-center rounded-full border border-[var(--color-fog)] bg-[var(--color-canvas)] text-[var(--color-slate)] hover:text-[var(--color-ink)] ${className}`}
    >
      <Icon className="size-4" strokeWidth={2} />
    </button>
  )
}

export function ProjectWorkspace({ projectId, onClose }: ProjectWorkspaceProps) {
  const [expanded, setExpanded] = useState(false)

  // Switching to a *different* project resets to docked; toggling expanded on
  // the SAME project must not change LoadedProjectWorkspace's identity, so the
  // already-fetched context survives the toggle (no refetch, no loading flash).
  useEffect(() => {
    setExpanded(false)
  }, [projectId])

  // The wrapper element type, the inner scroller, and the content wrapper are
  // identical between docked and full-cover renders — only their classNames
  // swap. That stable tree shape is what lets React keep
  // <LoadedProjectWorkspace key={projectId}> mounted across the toggle.
  const isFullCover = Boolean(projectId) && expanded

  return (
    <aside
      className={
        isFullCover
          ? 'fixed inset-0 z-40 bg-[var(--color-paper)]'
          : 'relative flex h-full w-[380px] shrink-0 flex-col border-l border-[var(--color-fog)] bg-[var(--color-paper)]'
      }
      aria-label="Project workspace"
    >
      <div
        className={
          isFullCover
            ? 'h-full overflow-y-auto'
            : 'min-h-0 flex-1 overflow-y-auto'
        }
      >
        <div className={isFullCover ? 'mx-auto max-w-3xl px-8 py-6' : 'px-6 py-6'}>
          {projectId ? (
            <LoadedProjectWorkspace
              key={projectId}
              projectId={projectId}
              expanded={isFullCover}
              onClose={onClose}
            />
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
      {projectId ? (
        <ExpandToggle
          expanded={isFullCover}
          onToggle={() => setExpanded((prev) => !prev)}
          // Mid-left-edge in both states — the docked tab-on-seam metaphor.
          // In docked, the panel's left edge IS the seam between map and
          // panel, so we center the button on it (-translate-x-1/2). In
          // full-cover the panel is the viewport, so we inset by left-4 to
          // keep the button fully visible at the same mid-height.
          className={
            isFullCover
              ? 'absolute left-4 top-1/2 z-10 -translate-y-1/2'
              : 'absolute left-0 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2'
          }
        />
      ) : null}
    </aside>
  )
}
