import { area } from '@turf/turf'
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ComplianceResults } from './ComplianceResults'
import { ParcelContextPanel } from './ParcelContextPanel'
import {
  checkSchemeCompliance,
  deleteScheme,
  fetchProjectContext,
  fetchProjectSchemes,
  saveScheme,
  updateScheme,
} from '../lib/data'
import type {
  Classification,
  ComplianceResult,
  Parcel,
  ParcelContext,
  Scheme,
} from '../lib/types'

const SQ_METERS_TO_SQ_FT = 10.7639
const ASSUMED_FLOOR_HEIGHT_FT = 12

type ProjectWorkspaceProps = {
  projectId: string | null
  onClose: () => void
  drawMode: boolean
  onToggleDraw: (next: boolean) => void
  drawnFootprint: GeoJSON.Polygon | null
  onClearFootprint: () => void
  onCurrentSchemeFootprint: (footprint: GeoJSON.Polygon | null) => void
  // Workspace → App: push the polygon to load into Terra Draw for edit
  // (start of session) or null (save / cancel). App relays it to Map. The
  // workspace doesn't read editingFootprint back from App — its own
  // editingSchemeId state is the source of truth for "am I editing".
  onEditingFootprintChange: (footprint: GeoJSON.Polygon | null) => void
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

function formatSquareFeet(sqFt: number): string {
  return Math.round(sqFt).toLocaleString('en-US')
}

function footprintSquareFeet(footprint: GeoJSON.Polygon): number {
  // @turf/turf's `area` returns square meters for any GeoJSON geometry; the
  // function accepts a bare geometry as well as a Feature/FeatureCollection.
  return area(footprint) * SQ_METERS_TO_SQ_FT
}

function gfaEstimate(footprintSf: number, heightFt: number): {
  floors: number
  grossFloorSf: number
} {
  // Floors model: a single elevation divided into 12-ft stories, with a
  // minimum of one. This is intentionally crude — it's a derived estimate
  // labeled as such, NOT a cited compliance value. The rule is governing
  // height; the floor count is just to give the user a feel for the volume
  // the cited height allows.
  const floors = Math.max(1, Math.floor(heightFt / ASSUMED_FLOOR_HEIGHT_FT))
  return { floors, grossFloorSf: footprintSf * floors }
}

type GfaLineProps = {
  footprintSf: number
  heightFt: number
}

function GfaLine({ footprintSf, heightFt }: GfaLineProps) {
  if (!(footprintSf > 0) || !(heightFt > 0)) return null
  const { floors, grossFloorSf } = gfaEstimate(footprintSf, heightFt)
  return (
    <>
      <p className="mt-2 font-sans text-xs text-[var(--color-graphite)]">
        Est. gross floor area: {formatSquareFeet(grossFloorSf)} SF
        <span className="text-[var(--color-slate)]">
          {' '}
          · {floors} {floors === 1 ? 'floor' : 'floors'} @{' '}
          {ASSUMED_FLOOR_HEIGHT_FT} ft
        </span>
      </p>
      <p className="mt-0.5 text-xs italic text-[var(--color-mist)]">
        Rough estimate — not a cited rule.
      </p>
    </>
  )
}

type SavedSchemeSummaryProps = {
  scheme: Scheme
}

// Renders the persisted scheme that opens with a project — name, footprint
// SF (taken from the server-computed footprint_sf for consistency with the
// PostGIS area), height, and the same gross-floor estimate the save flow
// shows. Owns its own compliance fetch keyed by scheme.id so that switching
// the current scheme (parent re-keys this component on scheme.id) naturally
// re-runs compliance — no parent-level setState-in-effect needed.
function SavedSchemeSummary({ scheme }: SavedSchemeSummaryProps) {
  const [compliance, setCompliance] = useState<ComplianceResult | null>(null)
  const [complianceError, setComplianceError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void checkSchemeCompliance(scheme.id)
      .then((result) => {
        if (!cancelled) setCompliance(result)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setComplianceError(
            e instanceof Error ? e.message : 'Compliance check failed',
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [scheme.id])

  return (
    <section>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        SAVED SCHEME
      </p>

      <p className="font-serif text-lg leading-tight text-[var(--color-ink)]">
        {scheme.name || 'Untitled scheme'}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Footprint
          </p>
          <p
            className="mt-0.5 font-serif text-2xl leading-none text-[var(--color-ink)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatSquareFeet(scheme.footprint_sf)}{' '}
            <span className="font-mono text-xs text-[var(--color-slate)]">
              SF
            </span>
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Height
          </p>
          <p
            className="mt-0.5 font-serif text-2xl leading-none text-[var(--color-ink)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {scheme.height_ft}{' '}
            <span className="font-mono text-xs text-[var(--color-slate)]">
              ft
            </span>
          </p>
        </div>
      </div>

      <GfaLine footprintSf={scheme.footprint_sf} heightFt={scheme.height_ft} />

      {compliance ? (
        <div className="mt-6">
          <ComplianceResults result={compliance} />
        </div>
      ) : complianceError ? (
        <p className="mt-4 font-sans text-xs text-[var(--color-ink)]">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-graphite)]">
            Compliance ·{' '}
          </span>
          {complianceError}
        </p>
      ) : (
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          checking compliance…
        </p>
      )}
    </section>
  )
}

type SchemeSectionProps = {
  projectId: string
  drawMode: boolean
  onToggleDraw: (next: boolean) => void
  drawnFootprint: GeoJSON.Polygon | null
  hasSavedScheme: boolean
  onSchemeSaved: () => void
}

function SchemeSection({
  projectId,
  drawMode,
  onToggleDraw,
  drawnFootprint,
  hasSavedScheme,
  onSchemeSaved,
}: SchemeSectionProps) {
  const [name, setName] = useState(hasSavedScheme ? '' : 'Option A')
  const [heightInput, setHeightInput] = useState('25')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const heightFt = Number.parseFloat(heightInput)
  const heightValid = Number.isFinite(heightFt) && heightFt > 0

  const footprintSf = useMemo(
    () => (drawnFootprint ? footprintSquareFeet(drawnFootprint) : null),
    [drawnFootprint],
  )

  const canSave = Boolean(drawnFootprint) && name.trim() !== '' && heightValid

  async function handleSave() {
    if (!drawnFootprint || !heightValid) return
    setSaving(true)
    setError(null)
    try {
      await saveScheme(projectId, name.trim(), drawnFootprint, heightFt)
      // Parent refetches schemes; the new one becomes the current saved
      // scheme and the SavedSchemeSummary above shows its compliance.
      onSchemeSaved()
      // Lock the footprint: turn off draw mode but keep the polygon rendered.
      // Terra Draw drops to 'static' on mode flip, so the geometry survives.
      if (drawMode) onToggleDraw(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const toggleClass = [
    'rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
    drawMode
      ? 'border border-[var(--color-accent)] bg-[var(--color-accent-wash)] text-[var(--color-accent)]'
      : 'hairline bg-white text-[var(--color-ink)] hover:bg-[var(--color-canvas)]',
  ].join(' ')

  const saveClass = [
    'mt-3 rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
    canSave && !saving
      ? 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-soft)]'
      : 'cursor-not-allowed bg-[var(--color-fog)] text-[var(--color-mist)]',
  ].join(' ')

  // Header label changes if there's already a saved scheme — same draw flow,
  // but the user is now creating a NEW option, not the first one.
  const heading = hasSavedScheme ? 'NEW SCHEME' : 'SCHEME'
  const toggleLabel = drawMode
    ? 'Stop drawing'
    : hasSavedScheme
      ? 'Draw new footprint'
      : 'Draw footprint'
  const saveLabel = saving
    ? 'Saving…'
    : hasSavedScheme
      ? 'Save as new scheme'
      : 'Save scheme'

  return (
    <section>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        {heading}
      </p>

      <button
        type="button"
        onClick={() => onToggleDraw(!drawMode)}
        className={toggleClass}
        aria-pressed={drawMode}
      >
        {toggleLabel}
      </button>

      {footprintSf !== null ? (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Draft footprint
          </p>
          <p
            className="mt-0.5 font-serif text-2xl leading-none text-[var(--color-ink)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatSquareFeet(footprintSf)}{' '}
            <span className="font-mono text-xs text-[var(--color-slate)]">
              SF
            </span>
          </p>
          <GfaLine footprintSf={footprintSf} heightFt={heightFt} />
        </div>
      ) : (
        <p className="mt-3 font-sans text-xs italic text-[var(--color-mist)]">
          Toggle drawing and click on the map to lay out a footprint.
        </p>
      )}

      <div className="mt-4 grid grid-cols-[1fr_5rem] gap-3">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="hairline mt-1 w-full rounded-sm bg-white px-2 py-1 font-sans text-sm text-[var(--color-ink)]"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Height
          </span>
          <div className="mt-1 flex items-baseline">
            <input
              type="number"
              min={0}
              step={1}
              value={heightInput}
              onChange={(e) => setHeightInput(e.target.value)}
              className="hairline w-full rounded-sm bg-white px-2 py-1 font-sans text-sm text-[var(--color-ink)]"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            />
            <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
              ft
            </span>
          </div>
        </label>
      </div>

      <button
        type="button"
        onClick={() => {
          void handleSave()
        }}
        disabled={!canSave || saving}
        className={saveClass}
      >
        {saveLabel}
      </button>

      {error ? (
        <p className="mt-2 font-sans text-xs text-[var(--color-ink)]">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-graphite)]">
            Error ·{' '}
          </span>
          {error}
        </p>
      ) : null}
    </section>
  )
}

type SchemeActionsProps = {
  // Hidden during an active edit session (the edit UI provides its own
  // Save / Cancel and a Delete during edit would be ambiguous). On the
  // delete-confirm row visibility stays true; the edit/delete pair is
  // simply swapped for the inline confirmation prompt.
  visible: boolean
  confirmingDelete: boolean
  deleting: boolean
  deleteError: string | null
  onStartEdit: () => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}

// Tiny mono action row that sits directly under the scheme selector. Edit
// and Delete are both rendered restrained (slate, mono, no border) so they
// don't compete with the dropdown trigger above; Delete is destructive but
// not loud — confirmation is what gates the action, not visual weight.
function SchemeActions({
  visible,
  confirmingDelete,
  deleting,
  deleteError,
  onStartEdit,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: SchemeActionsProps) {
  if (!visible && !confirmingDelete) return null

  if (confirmingDelete) {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <span className="font-sans text-xs text-[var(--color-graphite)]">
          Delete this scheme?
        </span>
        <button
          type="button"
          onClick={onConfirmDelete}
          disabled={deleting}
          className={`font-mono text-[10px] uppercase tracking-[0.08em] ${
            deleting
              ? 'cursor-not-allowed text-[var(--color-mist)]'
              : 'text-[var(--color-ink)] hover:underline'
          }`}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
        <button
          type="button"
          onClick={onCancelDelete}
          disabled={deleting}
          className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
        {deleteError ? (
          <p className="w-full text-right font-sans text-xs text-[var(--color-ink)]">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-graphite)]">
              Error ·{' '}
            </span>
            {deleteError}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mt-2 flex items-center justify-end gap-3">
      <button
        type="button"
        onClick={onStartEdit}
        className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
      >
        Edit
      </button>
      <span aria-hidden className="text-[var(--color-fog)]">
        ·
      </span>
      <button
        type="button"
        onClick={onRequestDelete}
        className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
      >
        Delete
      </button>
    </div>
  )
}

type EditSchemeSectionProps = {
  scheme: Scheme
  name: string
  height: string
  // The live edited polygon from Terra Draw. Starts equal to scheme.footprint
  // at edit-start and updates with every drag/vertex change via the existing
  // onFootprintDrawn pipeline. null means the editing feature was somehow
  // cleared mid-edit — in practice that shouldn't happen, but the UI guards
  // against it by disabling Save.
  editedFootprint: GeoJSON.Polygon | null
  saving: boolean
  error: string | null
  onNameChange: (next: string) => void
  onHeightChange: (next: string) => void
  onSave: () => void
  onCancel: () => void
}

// In-place edit panel. Mirrors SchemeSection's name/height/footprint
// rendering for visual continuity, but the Save button calls updateScheme
// rather than saveScheme, and the "Draft footprint" label reads "Editing
// footprint" so the user can tell which flow they're in.
function EditSchemeSection({
  scheme,
  name,
  height,
  editedFootprint,
  saving,
  error,
  onNameChange,
  onHeightChange,
  onSave,
  onCancel,
}: EditSchemeSectionProps) {
  const heightFt = Number.parseFloat(height)
  const heightValid = Number.isFinite(heightFt) && heightFt > 0
  const footprintSf = useMemo(
    () => (editedFootprint ? footprintSquareFeet(editedFootprint) : null),
    [editedFootprint],
  )
  const canSave =
    Boolean(editedFootprint) && name.trim() !== '' && heightValid && !saving

  const saveClass = [
    'rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
    canSave
      ? 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-soft)]'
      : 'cursor-not-allowed bg-[var(--color-fog)] text-[var(--color-mist)]',
  ].join(' ')

  const cancelClass =
    'rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] hairline bg-white text-[var(--color-ink)] hover:bg-[var(--color-canvas)] transition-colors'

  return (
    <section>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        EDITING SCHEME
      </p>

      <p className="font-sans text-xs italic text-[var(--color-slate)]">
        Drag the polygon, its vertices, or the rotation handle on the map.
        Changes save in place to "{scheme.name || 'Untitled scheme'}".
      </p>

      {footprintSf !== null ? (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Editing footprint
          </p>
          <p
            className="mt-0.5 font-serif text-2xl leading-none text-[var(--color-ink)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatSquareFeet(footprintSf)}{' '}
            <span className="font-mono text-xs text-[var(--color-slate)]">
              SF
            </span>
          </p>
          <GfaLine footprintSf={footprintSf} heightFt={heightFt} />
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-[1fr_5rem] gap-3">
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            className="hairline mt-1 w-full rounded-sm bg-white px-2 py-1 font-sans text-sm text-[var(--color-ink)]"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Height
          </span>
          <div className="mt-1 flex items-baseline">
            <input
              type="number"
              min={0}
              step={1}
              value={height}
              onChange={(e) => onHeightChange(e.target.value)}
              className="hairline w-full rounded-sm bg-white px-2 py-1 font-sans text-sm text-[var(--color-ink)]"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            />
            <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
              ft
            </span>
          </div>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          className={saveClass}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className={cancelClass}
        >
          Cancel
        </button>
      </div>

      {error ? (
        <p className="mt-2 font-sans text-xs text-[var(--color-ink)]">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-graphite)]">
            Error ·{' '}
          </span>
          {error}
        </p>
      ) : null}
    </section>
  )
}

type SchemeSelectorProps = {
  schemes: Scheme[]
  selectedId: string | null
  onSelect: (id: string) => void
  // While editing a scheme, the dropdown is disabled so the user can't
  // switch out mid-edit and silently drop their unsaved changes. They must
  // save or cancel first.
  disabled?: boolean
}

// Compact custom dropdown that lets the user switch which saved scheme is
// "current". Intentionally NOT a native <select>: the popover row shows
// scheme name + footprint SF so the user can tell options apart at a glance,
// which the platform select can't do without a richer affordance. View-only —
// edit/delete live elsewhere when they land. Owns its own open state; outside
// clicks and Escape close the popover. Per-row compliance dots are
// deliberately omitted to avoid fanning out N compliance RPCs just to render
// a chooser; compliance is fetched once for the *selected* scheme by
// SavedSchemeSummary.
function SchemeSelector({
  schemes,
  selectedId,
  onSelect,
  disabled = false,
}: SchemeSelectorProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const selected =
    schemes.find((s) => s.id === selectedId) ?? schemes[0] ?? null

  // Effective open state: clamp shut while disabled so the parent's "frozen
  // dropdown" intent doesn't require an effect-driven setOpen(false). The
  // raw `open` state is preserved so re-enabling restores the prior view —
  // but in practice disabled flips are tied to edit start/end, which the
  // user can't trigger from inside the popover.
  const popoverOpen = open && !disabled

  useEffect(() => {
    if (!popoverOpen) return
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
  }, [popoverOpen])

  if (!selected) return null

  return (
    <section ref={wrapperRef} className="relative">
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        VIEWING
      </p>
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          setOpen((prev) => !prev)
        }}
        aria-haspopup="listbox"
        aria-expanded={popoverOpen}
        aria-disabled={disabled}
        disabled={disabled}
        className={`hairline mt-1.5 flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left ${
          disabled
            ? 'cursor-not-allowed bg-[var(--color-fog)] text-[var(--color-mist)]'
            : 'bg-[var(--color-canvas)]'
        }`}
      >
        <span className="min-w-0 truncate font-sans text-sm text-[var(--color-ink)]">
          {selected.name || 'Untitled scheme'}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-[var(--color-slate)] transition-transform ${
            popoverOpen ? 'rotate-180' : ''
          }`}
          strokeWidth={2}
          aria-hidden
        />
      </button>
      {popoverOpen ? (
        <ul
          role="listbox"
          className="hairline absolute left-0 right-0 top-full z-20 mt-1 max-h-[260px] overflow-y-auto border bg-[var(--color-canvas)]"
        >
          {schemes.map((scheme, index) => {
            const isLast = index === schemes.length - 1
            const isSelected = scheme.id === selected.id
            return (
              <li
                key={scheme.id}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(scheme.id)
                  setOpen(false)
                }}
                className={`cursor-pointer px-2.5 py-1.5 ${
                  isSelected
                    ? 'bg-[var(--color-accent-wash)]'
                    : 'hover:bg-[var(--color-accent-wash)]'
                } ${isLast ? '' : 'hairline border-b'}`}
              >
                <div className="truncate font-sans text-sm text-[var(--color-ink)]">
                  {scheme.name || 'Untitled scheme'}
                </div>
                <div
                  className="font-mono text-xs text-[var(--color-slate)]"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatSquareFeet(scheme.footprint_sf)} SF
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
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
  drawMode: boolean
  onToggleDraw: (next: boolean) => void
  drawnFootprint: GeoJSON.Polygon | null
  onClearFootprint: () => void
  onCurrentSchemeFootprint: (footprint: GeoJSON.Polygon | null) => void
  onEditingFootprintChange: (footprint: GeoJSON.Polygon | null) => void
}

function LoadedProjectWorkspace({
  projectId,
  expanded,
  onClose,
  drawMode,
  onToggleDraw,
  drawnFootprint,
  onClearFootprint,
  onCurrentSchemeFootprint,
  onEditingFootprintChange,
}: LoadedProjectWorkspaceProps) {
  const [project, setProject] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [context, setContext] = useState<ParcelContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [schemes, setSchemes] = useState<Scheme[]>([])
  // Bumped after each save / update / delete so the schemes-refetch effect
  // re-runs. Routed through a token (rather than calling a refetch function
  // directly inside an effect) so all setState happens inside .then/.catch
  // callbacks, which is the pattern the codebase's lint posture rewards.
  const [schemesToken, setSchemesToken] = useState(0)
  // What to do with the selection AFTER the next refetch lands. Carried in a
  // ref (not state) so it doesn't add to the effect's dependency list and so
  // we can read-then-clear inside the .then callback without a second render.
  //   - 'newest':   a new scheme was inserted → jump to the newest (head of
  //                 the desc-ordered list) so SavedSchemeSummary shows the
  //                 scheme the user just saved.
  //   - 'preserve': an existing scheme was updated in place → keep current
  //                 selection (the auto-sync effect below also keeps it
  //                 since the id is still in the list).
  //   - null:       deletion or any other refetch → let auto-sync below
  //                 pick list[0] if the previous selection vanished.
  const postRefetchActionRef = useRef<'newest' | 'preserve' | null>(null)
  // Which saved scheme is "current". Null means "no preference" → defaults
  // to the most recent (schemes[0]). Schemes are fetched desc by created_at,
  // so head-of-list is canonical when nothing is explicitly selected.
  const [selectedSchemeId, setSelectedSchemeId] = useState<string | null>(null)
  const currentScheme: Scheme | null =
    schemes.find((s) => s.id === selectedSchemeId) ?? schemes[0] ?? null

  // Editing session state (in-place edit of an existing saved scheme). When
  // editingSchemeId is non-null the workspace swaps the SavedSchemeSummary
  // for an EditSchemeSection and hides the new-scheme SchemeSection; the
  // edited polygon lives in Terra Draw (via editingFootprint up-prop) and
  // its live geometry flows back through drawnFootprint.
  const [editingSchemeId, setEditingSchemeId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingHeight, setEditingHeight] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  // Latest-value mirror so the schemes-refetch .then callback can detect
  // "edit target disappeared" without re-running the fetch effect whenever
  // editingSchemeId changes.
  const editingSchemeIdRef = useRef<string | null>(editingSchemeId)
  useEffect(() => {
    editingSchemeIdRef.current = editingSchemeId
  })
  // Inline delete confirm (no native confirm()). Holds the id of the scheme
  // pending confirmation; null = no confirm visible.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Initial load: project context + schemes in parallel. Schemes failure is
  // swallowed to [] so a transient view-side hiccup doesn't blank the whole
  // workspace; project-context failure surfaces as the workspace error.
  useEffect(() => {
    let cancelled = false

    void Promise.all([
      fetchProjectContext(projectId),
      fetchProjectSchemes(projectId).catch(() => [] as Scheme[]),
    ])
      .then(([data, list]) => {
        if (cancelled) return
        setProject(data.project)
        setContext(data.context)
        setSchemes(list)
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

  // Refetch schemes after a save / update / delete. The initial value of
  // `schemesToken` is 0, and the initial-load effect above seeds `schemes`;
  // this effect short-circuits on the initial run to avoid a duplicate fetch.
  //
  // The selection policy after refetch is encoded in `postRefetchActionRef`
  // (read-then-cleared inside the .then callback). The save-id sync
  // intentionally lives here rather than in onSchemeSaved/onSchemeUpdated so
  // the selection only changes once the server has actually confirmed the
  // new list. For deletes we leave the action null and rely on the auto-
  // sync effect below to pick a sensible fallback when the prior selection
  // is no longer in the list.
  useEffect(() => {
    if (schemesToken === 0) return
    let cancelled = false
    void fetchProjectSchemes(projectId)
      .then((list) => {
        if (cancelled) return
        const action = postRefetchActionRef.current
        postRefetchActionRef.current = null
        setSchemes(list)
        if (action === 'newest' && list[0]) {
          setSelectedSchemeId(list[0].id)
        }
        // If the edit target was just deleted (or otherwise vanished from
        // the refetched list), abandon the edit session so the UI doesn't
        // keep referencing a stale scheme. Doing this in the .then callback
        // (rather than a separate effect that watches schemes) keeps the
        // setState calls outside an effect body.
        const editingId = editingSchemeIdRef.current
        if (editingId !== null && !list.some((s) => s.id === editingId)) {
          setEditingSchemeId(null)
          setEditingName('')
          setEditingHeight('')
          setEditError(null)
          onEditingFootprintChange(null)
        }
      })
      .catch(() => {
        if (!cancelled) setSchemes([])
      })
    return () => {
      cancelled = true
    }
  }, [schemesToken, projectId, onEditingFootprintChange])

  // Keep selectedSchemeId in sync with the list: if the previously selected
  // scheme disappears (e.g. switched projects, future delete) or no selection
  // has been made yet, default to the newest scheme. Selection that's still
  // present in the list is left alone — switching between two saved schemes
  // must not be clobbered when the array reference changes.
  useEffect(() => {
    setSelectedSchemeId((current) => {
      if (current && schemes.some((s) => s.id === current)) return current
      return schemes[0]?.id ?? null
    })
  }, [schemes])

  // Push the current scheme's footprint up to App so Map can render it as a
  // saved-scheme layer. Cleared to null on unmount so leaving the workspace
  // wipes the rendered polygon without waiting for the next selection.
  useEffect(() => {
    onCurrentSchemeFootprint(currentScheme?.footprint ?? null)
  }, [currentScheme, onCurrentSchemeFootprint])

  useEffect(() => {
    return () => {
      onCurrentSchemeFootprint(null)
    }
    // intentionally only run on unmount: projectId is the parent key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `onClearFootprint` is referenced in cleanup; declare it via a stable
  // closure so React's exhaustive-deps doesn't trip on the prop callback.
  useEffect(() => {
    return () => {
      // Leaving this project (switch or close) clears the draft footprint so
      // it doesn't bleed into the next project's workspace. The map polygon
      // is tied to drawnFootprint state via Terra Draw, so wiping the state
      // also wipes the rendered geometry on the next mode/effect tick.
      onClearFootprint()
    }
    // intentionally only run on unmount: projectId is the parent key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleStartEdit(scheme: Scheme) {
    // Stop drawing first so polygon-mode doesn't fight with select-mode in
    // Terra Draw (the editing-load effect in Map switches to select; if
    // drawMode is still on, exiting the edit later would snap back to
    // polygon, which we don't want).
    if (drawMode) onToggleDraw(false)
    setConfirmDeleteId(null)
    setDeleteError(null)
    setEditError(null)
    setEditingSchemeId(scheme.id)
    setEditingName(scheme.name)
    setEditingHeight(String(scheme.height_ft))
    // Pushes the polygon up to App, which mirrors it into drawnFootprint
    // and sends it to Map; Map then loads it into Terra Draw + select mode.
    onEditingFootprintChange(scheme.footprint)
  }

  function handleCancelEdit() {
    setEditingSchemeId(null)
    setEditingName('')
    setEditingHeight('')
    setEditError(null)
    setSavingEdit(false)
    onEditingFootprintChange(null)
  }

  async function handleSaveEdit() {
    if (editingSchemeId === null) return
    const trimmed = editingName.trim()
    const heightFt = Number.parseFloat(editingHeight)
    if (!trimmed || !Number.isFinite(heightFt) || heightFt <= 0) return
    if (!drawnFootprint) return

    setSavingEdit(true)
    setEditError(null)
    try {
      await updateScheme(editingSchemeId, trimmed, drawnFootprint, heightFt)
      // Preserve the current selection: an update doesn't change created_at,
      // so the scheme's position in the desc list is stable.
      postRefetchActionRef.current = 'preserve'
      setSchemesToken((n) => n + 1)
      // Hand the edited geometry to App's static-layer prop in the same
      // batch as the editing teardown. Without this, the saved-scheme layer
      // would reappear (because editingFootprint flipped to null) showing
      // the pre-edit geometry until the async refetch lands — a visible
      // snap-back. When the refetch resolves, currentScheme.footprint equals
      // drawnFootprint here, so the auto-sync push is a no-op.
      onCurrentSchemeFootprint(drawnFootprint)
      onEditingFootprintChange(null)
      setEditingSchemeId(null)
      setEditingName('')
      setEditingHeight('')
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingEdit(false)
    }
  }

  async function handleConfirmDelete(schemeId: string) {
    setDeleting(true)
    setDeleteError(null)
    try {
      // If the scheme being deleted is also being edited, abandon the edit
      // before the row goes away.
      if (editingSchemeId === schemeId) {
        onEditingFootprintChange(null)
        setEditingSchemeId(null)
        setEditingName('')
        setEditingHeight('')
      }
      await deleteScheme(schemeId)
      // After delete: the auto-sync effect below picks list[0] when the
      // previous selection is gone, so no explicit post-refetch action.
      setSelectedSchemeId((current) =>
        current === schemeId ? null : current,
      )
      setSchemesToken((n) => n + 1)
      setConfirmDeleteId(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

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
      <div className="my-4 border-t border-[var(--color-fog)]" aria-hidden />
      {currentScheme ? (
        <>
          {schemes.length >= 1 ? (
            <div className="mb-5">
              <SchemeSelector
                schemes={schemes}
                selectedId={selectedSchemeId}
                onSelect={setSelectedSchemeId}
                disabled={editingSchemeId !== null}
              />
              <SchemeActions
                visible={editingSchemeId === null}
                confirmingDelete={confirmDeleteId === currentScheme.id}
                deleting={deleting}
                deleteError={deleteError}
                onStartEdit={() => handleStartEdit(currentScheme)}
                onRequestDelete={() => setConfirmDeleteId(currentScheme.id)}
                onConfirmDelete={() =>
                  void handleConfirmDelete(currentScheme.id)
                }
                onCancelDelete={() => {
                  setConfirmDeleteId(null)
                  setDeleteError(null)
                }}
              />
            </div>
          ) : null}
          {editingSchemeId === currentScheme.id ? (
            <EditSchemeSection
              scheme={currentScheme}
              name={editingName}
              height={editingHeight}
              editedFootprint={drawnFootprint}
              saving={savingEdit}
              error={editError}
              onNameChange={setEditingName}
              onHeightChange={setEditingHeight}
              onSave={() => void handleSaveEdit()}
              onCancel={handleCancelEdit}
            />
          ) : (
            <SavedSchemeSummary
              key={currentScheme.id}
              scheme={currentScheme}
            />
          )}
          <div className="my-4 border-t border-[var(--color-fog)]" aria-hidden />
        </>
      ) : null}
      {editingSchemeId === null ? (
        <SchemeSection
          projectId={projectId}
          drawMode={drawMode}
          onToggleDraw={onToggleDraw}
          drawnFootprint={drawnFootprint}
          hasSavedScheme={currentScheme !== null}
          onSchemeSaved={() => {
            postRefetchActionRef.current = 'newest'
            setSchemesToken((n) => n + 1)
          }}
        />
      ) : null}
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

export function ProjectWorkspace({
  projectId,
  onClose,
  drawMode,
  onToggleDraw,
  drawnFootprint,
  onClearFootprint,
  onCurrentSchemeFootprint,
  onEditingFootprintChange,
}: ProjectWorkspaceProps) {
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
              drawMode={drawMode}
              onToggleDraw={onToggleDraw}
              drawnFootprint={drawnFootprint}
              onClearFootprint={onClearFootprint}
              onCurrentSchemeFootprint={onCurrentSchemeFootprint}
              onEditingFootprintChange={onEditingFootprintChange}
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
