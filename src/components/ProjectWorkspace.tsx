import { area } from '@turf/turf'
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ComplianceResults, ResultRow, aggregateStatus } from './ComplianceResults'
import { ParcelContextPanel } from './ParcelContextPanel'
import {
  checkSchemeCompliance,
  deleteScheme,
  fetchProjectContext,
  fetchProjectSchemes,
  fetchSchemeFootprints,
  saveScheme,
  updateScheme,
} from '../lib/data'
import type {
  Classification,
  ComplianceEntry,
  ComplianceResult,
  DrawnFootprint,
  FootprintMeta,
  Parcel,
  ParcelContext,
  Scheme,
  SchemeFootprint,
} from '../lib/types'

const SQ_METERS_TO_SQ_FT = 10.7639
const ASSUMED_FLOOR_HEIGHT_FT = 12

type ProjectWorkspaceProps = {
  projectId: string | null
  onClose: () => void
  drawMode: boolean
  onToggleDraw: (next: boolean) => void
  // Imperative "draw another" trigger: bumps the App-level arm token so
  // Map re-enters polygon mode without going through a drawMode toggle.
  // Needed because Terra Draw's finish handler auto-parks each completed
  // pad in 'select' mode, and the mode/drawMode effect only fires on
  // state changes — so we can't re-arm by calling onToggleDraw(true)
  // when drawMode is already true.
  onArmDraw: () => void
  // The full current set of polygons in Terra Draw, with stable feature
  // ids. The workspace replaces (never merges) on each update.
  drawnFootprints: DrawnFootprint[]
  onClearFootprints: () => void
  onCurrentSchemeFootprints: (footprints: SchemeFootprint[] | null) => void
  // Workspace → App: push the seed polygons to load into Terra Draw at
  // edit start, or null at save/cancel. App relays it to Map. The
  // workspace doesn't read this back — its own editingSchemeId state is
  // the source of truth for "am I editing".
  onEditingChange: (seeds: GeoJSON.Polygon[] | null) => void
  // Per-footprint UI: ask Map to switch into select mode and select the
  // given Terra Draw feature, or to remove it. The workspace exposes
  // these via the "Select on map" / "×" buttons on each row. App routes
  // both through token-bumping state into Map (see App.tsx).
  onSelectFootprint: (id: string | number) => void
  onRemoveFootprint: (id: string | number) => void
  // Map → workspace: the id of the currently selected feature in Terra
  // Draw (per its select/deselect events). The workspace renders the
  // matching row with an accent highlight so panel ↔ map selection stays
  // in lockstep.
  selectedFootprintId: string | number | null
  // Saved-scheme multi-select: the set of saved-footprint ids that are
  // currently selected (toggled by panel-row clicks and map clicks on
  // saved-scheme polygons). Distinct from selectedFootprintId, which is
  // edit-mode single-target Terra Draw selection.
  selectedSavedFootprintIds: Set<string | number>
  onToggleSavedFootprint: (id: string | number) => void
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

// Local mirrors of ComplianceResults' internal statusWord/statusWordClass.
// Duplicated rather than exported so ComplianceResults keeps a narrow
// public surface — both versions are short and stable.
function statusWord(result: ComplianceEntry['result']): string {
  if (result === 'pass') return 'PASS'
  if (result === 'fail') return 'FAIL'
  return 'N/E'
}
function statusWordClass(result: ComplianceEntry['result']): string {
  if (result === 'pass') return 'text-[var(--color-accent)]'
  if (result === 'fail') return 'text-[var(--color-ink)]'
  return 'text-[var(--color-mist)]'
}

function footprintSquareFeet(footprint: GeoJSON.Polygon): number {
  // @turf/turf's `area` returns square meters for any GeoJSON geometry; the
  // function accepts a bare geometry as well as a Feature/FeatureCollection.
  return area(footprint) * SQ_METERS_TO_SQ_FT
}

// Sum of per-polygon footprint areas (NOT the union). This matches the
// draft pre-save view; once saved, the server returns a union area via
// scheme.footprint_sf, which the SavedSchemeSummary uses instead. The two
// can disagree if footprints overlap — that's expected and the per-polygon
// breakdown view that lands next step will make the distinction visible.
function totalFootprintSf(fps: DrawnFootprint[]): number {
  return fps.reduce((sum, fp) => sum + footprintSquareFeet(fp.geometry), 0)
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
  // Per-footprint records for the current scheme. Renders the
  // per-footprint summary list below the aggregate stats so the user can
  // see each building's name and area at a glance; selection here keeps
  // the map highlight and the compliance panel scroll in lockstep.
  footprints: SchemeFootprint[]
  // Saved-scheme selection is multi-target (a Set, not a single id):
  // clicking a panel row OR the map polygon toggles its id in this set,
  // so several saved buildings can be lit up at once. Edit-mode flows
  // (SchemeSection / EditSchemeSection / FootprintList) are still
  // single-id and continue to use selectedFootprintId / onSelectFootprint.
  selectedSavedFootprintIds: Set<string | number>
  onToggleSavedFootprint: (id: string | number) => void
}

// Renders the persisted scheme that opens with a project — name, footprint
// count, total footprint SF (the server-side union via ST_Area, taken from
// scheme.footprint_sf for consistency with PostGIS), and a per-footprint
// list. Owns its own compliance fetch keyed by scheme.id so that switching
// the current scheme (parent re-keys this component on scheme.id) naturally
// re-runs compliance.
function SavedSchemeSummary({
  scheme,
  footprints,
  selectedSavedFootprintIds,
  onToggleSavedFootprint,
}: SavedSchemeSummaryProps) {
  const [compliance, setCompliance] = useState<ComplianceResult | null>(null)
  const [complianceError, setComplianceError] = useState<string | null>(null)
  // Set of stringified footprint ids that are currently expanded inline.
  // A Set (not a single id) because row expansion is per-row and
  // independent — multiple buildings can be open at once. Map selection
  // remains single-target (Terra Draw), tracked by selectedFootprintId
  // from the parent.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

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

  // Clicking a row toggles BOTH expansion and map selection in one go,
  // per the product decision that row-click is the only entry point for
  // expansion (map clicks select but never expand). Selection is now
  // multi-target via a Set; the routed handler toggles the id in App's
  // set so panel and map clicks stay in lockstep.
  function handleToggle(id: string | number) {
    const key = String(id)
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    onToggleSavedFootprint(id)
  }

  // Group compliance entries by footprint id for per-row rendering. When
  // compliance is null (still loading) or fetch failed, this is an empty
  // Map — rows still render their header (label + area), they just show
  // N/E as the aggregate and have no inline detail to expand to.
  const entriesByFootprintId = useMemo(() => {
    const map = new Map<string, ComplianceEntry[]>()
    if (!compliance) return map
    for (const entry of compliance.results) {
      if (entry.footprint_id === undefined) continue
      const key = String(entry.footprint_id)
      const arr = map.get(key)
      if (arr) arr.push(entry)
      else map.set(key, [entry])
    }
    return map
  }, [compliance])

  // Only render the (now scheme-level-only) ComplianceResults block when
  // there's actually something to show — otherwise it would render an
  // empty "no scheme-level constraints" placeholder for every scheme,
  // which is noise.
  const hasSchemeLevelEntries = useMemo(
    () => compliance?.results.some((e) => e.footprint_id === undefined) ?? false,
    [compliance],
  )

  // Prefer the count carried on the parent scheme summary (it's the
  // canonical server-side count); fall back to the footprints array only
  // when the parent's load hasn't landed yet.
  const count = scheme.footprint_count || footprints.length

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
            Footprints
          </p>
          <p
            className="mt-0.5 font-serif text-2xl leading-none text-[var(--color-ink)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {count}
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Total footprint
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
      </div>

      <p className="mt-5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        BUILDINGS
      </p>
      <BuildingList
        footprints={footprints}
        entriesByFootprintId={entriesByFootprintId}
        selectedSavedFootprintIds={selectedSavedFootprintIds}
        expandedIds={expandedIds}
        onToggle={handleToggle}
      />

      {compliance && hasSchemeLevelEntries ? (
        <div className="mt-6">
          <ComplianceResults result={compliance} />
        </div>
      ) : !compliance && !complianceError ? (
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          checking compliance…
        </p>
      ) : complianceError ? (
        <p className="mt-4 font-sans text-xs text-[var(--color-ink)]">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-graphite)]">
            Compliance ·{' '}
          </span>
          {complianceError}
        </p>
      ) : null}
    </section>
  )
}

// Pick the lowest unused "Building N" label given the set of currently
// taken labels. Auto labels are STICKY once assigned to a row — the
// reconciliation effect below never re-numbers existing rows when others
// are deleted, so an early delete leaves a gap that the next new row
// fills. This matches a CAD/site-planning expectation: Building 2 stays
// Building 2 across the session even if Building 1 is removed.
function nextLabel(taken: Set<string>): string {
  for (let i = 1; i < 10000; i++) {
    const candidate = `Building ${i}`
    if (!taken.has(candidate)) return candidate
  }
  return 'Building'
}

type FootprintRowProps = {
  fp: DrawnFootprint
  meta: FootprintMeta
  // The panel's current single height input, used as the displayed fallback
  // (and placeholder text) when this row has no per-row height yet
  // (meta.height_ft === null). At save time the row's value wins; the
  // panel default is only used when the row is null.
  defaultHeightFt: number | null
  isSelected: boolean
  onLabelChange: (id: string | number, label: string) => void
  onHeightChange: (id: string | number, height_ft: number | null) => void
  onSelect: (id: string | number) => void
  onRemove: (id: string | number) => void
}

// One polygon's row inside the per-footprint list. Visual treatment
// mirrors SchemeSelector's selected list-item: when isSelected the row
// gains an accent-wash background and an accent left-border. The label
// input shows the auto label as placeholder when the user hasn't typed;
// the height input shows the panel default as placeholder when this row
// has no per-row value. "Select on map" disables to "Selected" when the
// row is the current map selection so the affordance reads as a status
// rather than a no-op button.
function FootprintRow({
  fp,
  meta,
  defaultHeightFt,
  isSelected,
  onLabelChange,
  onHeightChange,
  onSelect,
  onRemove,
}: FootprintRowProps) {
  const sf = footprintSquareFeet(fp.geometry)
  const heightDisplay = meta.height_ft === null ? '' : String(meta.height_ft)
  const heightPlaceholder =
    defaultHeightFt !== null && Number.isFinite(defaultHeightFt)
      ? String(defaultHeightFt)
      : ''

  return (
    <li
      className={`flex flex-wrap items-end gap-x-3 gap-y-2 border-l-2 px-2.5 py-2 ${
        isSelected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
          : 'border-transparent'
      }`}
    >
      <label className="block min-w-0 flex-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          Label
        </span>
        <input
          type="text"
          value={meta.label}
          onChange={(e) => onLabelChange(fp.id, e.target.value)}
          placeholder={meta.label}
          className="hairline mt-1 w-full rounded-sm bg-white px-2 py-1 font-sans text-sm text-[var(--color-ink)]"
        />
      </label>
      <label className="block w-20 shrink-0">
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          Height
        </span>
        <div className="mt-1 flex items-baseline">
          <input
            type="number"
            min={0}
            step={1}
            value={heightDisplay}
            placeholder={heightPlaceholder}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') {
                onHeightChange(fp.id, null)
                return
              }
              const parsed = Number.parseFloat(raw)
              onHeightChange(
                fp.id,
                Number.isFinite(parsed) ? parsed : null,
              )
            }}
            className="hairline w-full rounded-sm bg-white px-2 py-1 font-sans text-sm text-[var(--color-ink)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          />
          <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            ft
          </span>
        </div>
      </label>
      <div className="flex w-full items-center justify-between gap-3">
        <p
          className="font-mono text-xs text-[var(--color-slate)]"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {formatSquareFeet(sf)}{' '}
          <span className="text-[var(--color-mist)]">SF</span>
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onSelect(fp.id)}
            disabled={isSelected}
            className={`font-mono text-[10px] uppercase tracking-[0.08em] ${
              isSelected
                ? 'cursor-default text-[var(--color-mist)]'
                : 'text-[var(--color-slate)] hover:text-[var(--color-ink)]'
            }`}
          >
            {isSelected ? 'Selected' : 'Select on map'}
          </button>
          <button
            type="button"
            onClick={() => onRemove(fp.id)}
            aria-label={`Delete ${meta.label}`}
            className="font-mono text-sm leading-none text-[var(--color-slate)] hover:text-[var(--color-ink)]"
          >
            ×
          </button>
        </div>
      </div>
    </li>
  )
}

type BuildingRowProps = {
  fp: SchemeFootprint
  // Per-footprint compliance entries for THIS building. Empty means
  // compliance hasn't loaded yet OR no per-footprint rules ran.
  entries: ComplianceEntry[]
  isSelected: boolean
  isExpanded: boolean
  // Single handler that the parent uses to toggle BOTH expansion and
  // map selection in one go. The row itself never calls into the map.
  onClick: () => void
}

// Read-only saved-scheme row, restyled so the whole row is the click
// target (no separate "Select on map" button). Clicking expands the row
// AND selects it on the map; clicking again collapses + deselects.
// Multiple rows can be expanded independently (a Set in the parent),
// but only one can be map-selected at a time (Terra Draw is single-
// select), so isSelected and isExpanded are tracked separately.
function BuildingRow({
  fp,
  entries,
  isSelected,
  isExpanded,
  onClick,
}: BuildingRowProps) {
  const aggregate = aggregateStatus(entries)

  return (
    <li
      className={`border-l-2 ${
        isSelected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-wash)]'
          : 'border-transparent'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        aria-expanded={isExpanded}
        className="flex w-full flex-wrap items-end gap-x-3 gap-y-2 px-2.5 py-2 text-left hover:bg-[var(--color-canvas)]"
      >
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Label
          </p>
          <p className="mt-1 truncate font-sans text-sm text-[var(--color-ink)]">
            {fp.label}
          </p>
        </div>
        <div className="flex w-full items-center justify-between gap-3">
          <p
            className="font-mono text-xs text-[var(--color-slate)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatSquareFeet(fp.footprint_sf)}{' '}
            <span className="text-[var(--color-mist)]">SF</span>
          </p>
          <div className="flex items-center gap-2">
            <span
              className={`font-mono text-[10px] uppercase tracking-[0.08em] ${statusWordClass(aggregate)}`}
            >
              {statusWord(aggregate)}
            </span>
            <ChevronRight
              className={`size-3.5 text-[var(--color-slate)] transition-transform ${isExpanded ? 'rotate-90' : ''}`}
              strokeWidth={2}
              aria-hidden
            />
          </div>
        </div>
      </button>
      {isExpanded && entries.length > 0 ? (
        <div className="border-t border-[var(--color-fog)] bg-[var(--color-paper)] px-2.5 py-2">
          <div className="divide-y divide-[var(--color-fog)]">
            {entries.map((entry, idx) => (
              <ResultRow
                key={`${entry.rule_key}-${entry.check_kind}-${idx}`}
                entry={entry}
              />
            ))}
          </div>
        </div>
      ) : null}
    </li>
  )
}

type BuildingListProps = {
  footprints: SchemeFootprint[]
  // Per-footprint compliance entries, keyed by stringified footprint id.
  // The parent (SavedSchemeSummary) builds this from compliance.results.
  entriesByFootprintId: Map<string, ComplianceEntry[]>
  // Multi-select of currently-selected saved-footprint ids. A row's
  // isSelected highlight is driven by membership in this set, so
  // multiple buildings can be visually selected at once.
  selectedSavedFootprintIds: Set<string | number>
  // Set of stringified footprint ids that are currently expanded. A Set
  // (not a single id) because row expansion is independent per row.
  expandedIds: Set<string>
  onToggle: (id: string | number) => void
}

// Read-only counterpart to FootprintList for saved schemes. Each row
// holds its own inline compliance section, expanded/collapsed by the
// parent. Selection (single) and expansion (multi) are tracked
// independently — a row can be expanded without being selected, and
// vice-versa.
function BuildingList({
  footprints,
  entriesByFootprintId,
  selectedSavedFootprintIds,
  expandedIds,
  onToggle,
}: BuildingListProps) {
  if (footprints.length === 0) return null
  return (
    <ul className="mt-3 space-y-1">
      {footprints.map((fp) => {
        const key = String(fp.id)
        const isSelected = selectedSavedFootprintIds.has(fp.id)
        const isExpanded = expandedIds.has(key)
        const entries = entriesByFootprintId.get(key) ?? []
        return (
          <BuildingRow
            key={key}
            fp={fp}
            entries={entries}
            isSelected={isSelected}
            isExpanded={isExpanded}
            onClick={() => onToggle(fp.id)}
          />
        )
      })}
    </ul>
  )
}

type FootprintListProps = {
  footprints: DrawnFootprint[]
  metaById: Record<string, FootprintMeta>
  defaultHeightFt: number | null
  selectedFootprintId: string | number | null
  onLabelChange: (id: string | number, label: string) => void
  onHeightChange: (id: string | number, height_ft: number | null) => void
  onSelect: (id: string | number) => void
  onRemove: (id: string | number) => void
}

// Renders the per-footprint stack. Used by both SchemeSection (draft
// footprints) and EditSchemeSection (edited footprints) so the row layout
// stays identical across the two flows. The list is the only place the
// user can rename or per-footprint-height a polygon — the panel's single
// Height input remains as the default for NEW rows only.
function FootprintList({
  footprints,
  metaById,
  defaultHeightFt,
  selectedFootprintId,
  onLabelChange,
  onHeightChange,
  onSelect,
  onRemove,
}: FootprintListProps) {
  if (footprints.length === 0) return null
  return (
    <ul className="mt-3 space-y-1">
      {footprints.map((fp) => {
        const key = String(fp.id)
        const meta = metaById[key] ?? { label: 'Building', height_ft: null }
        const isSelected =
          selectedFootprintId !== null && String(selectedFootprintId) === key
        return (
          <FootprintRow
            key={key}
            fp={fp}
            meta={meta}
            defaultHeightFt={defaultHeightFt}
            isSelected={isSelected}
            onLabelChange={onLabelChange}
            onHeightChange={onHeightChange}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        )
      })}
    </ul>
  )
}

type SchemeSectionProps = {
  projectId: string
  drawMode: boolean
  onToggleDraw: (next: boolean) => void
  // Re-arm Terra Draw into polygon mode without flipping drawMode.
  // Powers the "Draw another" affordance after a pad finishes.
  onArmDraw: () => void
  drawnFootprints: DrawnFootprint[]
  hasSavedScheme: boolean
  onSchemeSaved: () => void
  // Per-footprint state owned by LoadedProjectWorkspace, threaded down so
  // the row list and the save handler both read from the same dict.
  metaById: Record<string, FootprintMeta>
  selectedFootprintId: string | number | null
  onLabelChange: (id: string | number, label: string) => void
  onHeightChange: (id: string | number, height_ft: number | null) => void
  onSelectFootprint: (id: string | number) => void
  onRemoveFootprint: (id: string | number) => void
}

function SchemeSection({
  projectId,
  drawMode,
  onToggleDraw,
  onArmDraw,
  drawnFootprints,
  hasSavedScheme,
  onSchemeSaved,
  metaById,
  selectedFootprintId,
  onLabelChange,
  onHeightChange,
  onSelectFootprint,
  onRemoveFootprint,
}: SchemeSectionProps) {
  const [name, setName] = useState(hasSavedScheme ? '' : 'Option A')
  const [heightInput, setHeightInput] = useState('25')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const heightFt = Number.parseFloat(heightInput)
  const heightValid = Number.isFinite(heightFt) && heightFt > 0

  const footprintSf = useMemo(
    () => totalFootprintSf(drawnFootprints),
    [drawnFootprints],
  )

  const canSave =
    drawnFootprints.length > 0 && name.trim() !== '' && heightValid

  async function handleSave() {
    if (drawnFootprints.length === 0 || !heightValid) return
    setSaving(true)
    setError(null)
    try {
      // Per-row label/height live in metaById; the panel's single height
      // input is the FALLBACK for rows that still carry a null per-row
      // value, and 'Building' is the last-resort label fallback for any
      // row that somehow lacks a meta entry (the reconciliation effect
      // makes that unreachable in practice).
      await saveScheme(
        projectId,
        name.trim(),
        drawnFootprints.map((fp) => {
          const meta = metaById[String(fp.id)]
          return {
            geojson: fp.geometry,
            height_ft: meta?.height_ft ?? heightFt,
            label: meta?.label ?? 'Building',
          }
        }),
      )
      // Parent refetches schemes; the new one becomes the current saved
      // scheme and the SavedSchemeSummary above shows its compliance.
      onSchemeSaved()
      // Lock the footprints: turn off draw mode but keep the polygons
      // rendered. Terra Draw drops to 'static' on mode flip, so the
      // geometry survives.
      if (drawMode) onToggleDraw(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  // Primary (pressed) style — used for the "Draw footprint" entry button
  // when drawing is off and for "Draw another" while it's on. Mirrors the
  // pre-fix toggleClass intent so the visual emphasis stays on the
  // primary draw action across both states.
  const primaryDrawClass =
    'rounded-sm border border-[var(--color-accent)] bg-[var(--color-accent-wash)] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-accent)] transition-colors'

  // Secondary affordance: "Done drawing" turns the toggle off. Restrained
  // hairline style so it doesn't compete with the primary action.
  const secondaryDrawClass =
    'rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] hairline bg-white text-[var(--color-ink)] hover:bg-[var(--color-canvas)] transition-colors'

  // The off-state entry button when drawing hasn't started yet.
  const enterDrawClass =
    'rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] hairline bg-white text-[var(--color-ink)] hover:bg-[var(--color-canvas)] transition-colors'

  const saveClass = [
    'mt-3 rounded-sm px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] transition-colors',
    canSave && !saving
      ? 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-soft)]'
      : 'cursor-not-allowed bg-[var(--color-fog)] text-[var(--color-mist)]',
  ].join(' ')

  // Header label changes if there's already a saved scheme — same draw flow,
  // but the user is now creating a NEW option, not the first one.
  const heading = hasSavedScheme ? 'NEW SCHEME' : 'SCHEME'
  const enterDrawLabel = hasSavedScheme ? 'Draw new footprint' : 'Draw footprint'
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

      {drawMode ? (
        // Active drawing: split into two affordances so the user can rack
        // up footprints without leaving draw mode. "Draw another"
        // re-arms Terra Draw into polygon mode (the finish handler keeps
        // parking it in 'select' after each pad); "Done drawing" exits.
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onArmDraw}
            className={primaryDrawClass}
            aria-pressed
          >
            Draw another
          </button>
          <button
            type="button"
            onClick={() => onToggleDraw(false)}
            className={secondaryDrawClass}
          >
            Done drawing
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onToggleDraw(true)}
          className={enterDrawClass}
          aria-pressed={false}
        >
          {enterDrawLabel}
        </button>
      )}

      {drawnFootprints.length > 0 ? (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Draft footprint
            <span className="ml-2 normal-case tracking-normal text-[var(--color-mist)]">
              {drawnFootprints.length}{' '}
              {drawnFootprints.length === 1
                ? 'footprint'
                : 'footprints'}
            </span>
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
          <FootprintList
            footprints={drawnFootprints}
            metaById={metaById}
            defaultHeightFt={heightValid ? heightFt : null}
            selectedFootprintId={selectedFootprintId}
            onLabelChange={onLabelChange}
            onHeightChange={onHeightChange}
            onSelect={onSelectFootprint}
            onRemove={onRemoveFootprint}
          />
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
            Default height
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
  // The live edited polygons from Terra Draw. Starts equal to the scheme's
  // seeded footprints at edit-start and updates with every drag/vertex
  // change via the onFootprintsChanged pipeline. Empty means the editing
  // features were cleared mid-edit — in practice that shouldn't happen,
  // but the UI guards against it by disabling Save.
  editedFootprints: DrawnFootprint[]
  saving: boolean
  error: string | null
  onNameChange: (next: string) => void
  onHeightChange: (next: string) => void
  onSave: () => void
  onCancel: () => void
  // Imperative re-arm so the user can append a footprint to the scheme
  // being edited. The new polygon joins drawnFootprints via the existing
  // onFootprintsChanged emit and handleSaveEdit already maps all
  // drawnFootprints into the update payload.
  onArmDraw: () => void
  // Per-footprint state for the edit flow — same shape as SchemeSection.
  metaById: Record<string, FootprintMeta>
  selectedFootprintId: string | number | null
  onLabelChange: (id: string | number, label: string) => void
  onFootprintHeightChange: (
    id: string | number,
    height_ft: number | null,
  ) => void
  onSelectFootprint: (id: string | number) => void
  onRemoveFootprint: (id: string | number) => void
}

// In-place edit panel. Mirrors SchemeSection's name/height/footprint
// rendering for visual continuity, but the Save button calls updateScheme
// rather than saveScheme, and the "Draft footprint" label reads "Editing
// footprint" so the user can tell which flow they're in.
function EditSchemeSection({
  scheme,
  name,
  height,
  editedFootprints,
  saving,
  error,
  onNameChange,
  onHeightChange,
  onSave,
  onCancel,
  onArmDraw,
  metaById,
  selectedFootprintId,
  onLabelChange,
  onFootprintHeightChange,
  onSelectFootprint,
  onRemoveFootprint,
}: EditSchemeSectionProps) {
  const heightFt = Number.parseFloat(height)
  const heightValid = Number.isFinite(heightFt) && heightFt > 0
  const footprintSf = useMemo(
    () => totalFootprintSf(editedFootprints),
    [editedFootprints],
  )
  const canSave =
    editedFootprints.length > 0 && name.trim() !== '' && heightValid && !saving

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

      {editedFootprints.length > 0 ? (
        <div className="mt-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            Editing footprint
            <span className="ml-2 normal-case tracking-normal text-[var(--color-mist)]">
              {editedFootprints.length}{' '}
              {editedFootprints.length === 1
                ? 'footprint'
                : 'footprints'}
            </span>
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
          <FootprintList
            footprints={editedFootprints}
            metaById={metaById}
            defaultHeightFt={heightValid ? heightFt : null}
            selectedFootprintId={selectedFootprintId}
            onLabelChange={onLabelChange}
            onHeightChange={onFootprintHeightChange}
            onSelect={onSelectFootprint}
            onRemove={onRemoveFootprint}
          />
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
            Default height
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
        {/* "Draw another" inside the edit panel lets the user grow the
            scheme they're editing. The new polygon flows back through the
            usual drawnFootprints pipeline and handleSaveEdit picks it up
            in its update payload. */}
        <button
          type="button"
          onClick={onArmDraw}
          disabled={saving}
          className={cancelClass}
        >
          Draw another footprint
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
  onArmDraw: () => void
  drawnFootprints: DrawnFootprint[]
  onClearFootprints: () => void
  onCurrentSchemeFootprints: (footprints: SchemeFootprint[] | null) => void
  onEditingChange: (seeds: GeoJSON.Polygon[] | null) => void
  onSelectFootprint: (id: string | number) => void
  onRemoveFootprint: (id: string | number) => void
  selectedFootprintId: string | number | null
  // Saved-scheme multi-select threaded down to SavedSchemeSummary /
  // BuildingList. Edit-mode flows continue to use selectedFootprintId
  // and onSelectFootprint above.
  selectedSavedFootprintIds: Set<string | number>
  onToggleSavedFootprint: (id: string | number) => void
}

function LoadedProjectWorkspace({
  projectId,
  expanded,
  onClose,
  drawMode,
  onToggleDraw,
  onArmDraw,
  drawnFootprints,
  onClearFootprints,
  onCurrentSchemeFootprints,
  onEditingChange,
  onSelectFootprint,
  onRemoveFootprint,
  selectedFootprintId,
  selectedSavedFootprintIds,
  onToggleSavedFootprint,
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

  // The per-footprint records for the current scheme. Sourced from the
  // scheme_footprints_geojson view (one row per polygon) and used both to
  // render the saved-scheme map layer (via onCurrentSchemeFootprints) and
  // to seed Terra Draw at edit start (via onEditingChange).
  const [currentFootprints, setCurrentFootprints] = useState<
    SchemeFootprint[]
  >([])

  // Per-footprint label + height, keyed by Terra Draw's stable feature id
  // (stringified). Terra Draw owns geometry; this dict owns the bits of
  // app-side state that hang off each polygon. The reconciliation effect
  // below is the single writer of new/dropped keys — handlers only mutate
  // existing entries.
  const [metaById, setMetaById] = useState<Record<string, FootprintMeta>>({})

  // Reconcile metaById against the live set of Terra Draw ids on every
  // drawnFootprints change. Existing entries are carried over (height +
  // label are sticky once set); new ids get an auto-label "Building N"
  // where N is the lowest unused integer at the moment of creation; and
  // ids that vanished (delete, undo, edit-end teardown) are dropped by
  // virtue of not being copied over. This is the ONLY writer of new or
  // dropped keys — the per-row change handlers mutate entries in place
  // and never insert. Auto labels are intentionally not re-numbered when
  // earlier rows are deleted, matching the CAD convention.
  useEffect(() => {
    // Reconciles the per-footprint metadata map (label + height, keyed by
    // Terra Draw feature id) against drawnFootprints, which comes from an
    // external source of truth (Terra Draw's store) via prop. Preserves
    // existing entries, drops vanished ids, default-fills new ones. This
    // is bookkeeping against an external system — the rule's documented
    // use case for effects — not derived state in disguise (the per-row
    // label/height the user types ARE local state). A future architecture
    // pass could lift this reconciliation to the prop boundary in App and
    // remove the effect; deferred as out of scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMetaById((prev) => {
      const next: Record<string, FootprintMeta> = {}
      const takenLabels = new Set<string>()
      for (const fp of drawnFootprints) {
        const key = String(fp.id)
        const existing = prev[key]
        if (existing) {
          next[key] = existing
          takenLabels.add(existing.label)
        }
      }
      for (const fp of drawnFootprints) {
        const key = String(fp.id)
        if (next[key]) continue
        const label = nextLabel(takenLabels)
        takenLabels.add(label)
        next[key] = { label, height_ft: null }
      }
      return next
    })
  }, [drawnFootprints])

  const handleFootprintLabel = useCallback(
    (id: string | number, label: string) => {
      setMetaById((prev) => {
        const key = String(id)
        const existing = prev[key]
        if (!existing) return prev
        return { ...prev, [key]: { ...existing, label } }
      })
    },
    [],
  )

  const handleFootprintHeight = useCallback(
    (id: string | number, height_ft: number | null) => {
      setMetaById((prev) => {
        const key = String(id)
        const existing = prev[key]
        if (!existing) return prev
        return { ...prev, [key]: { ...existing, height_ft } }
      })
    },
    [],
  )

  // Editing session state (in-place edit of an existing saved scheme). When
  // editingSchemeId is non-null the workspace swaps the SavedSchemeSummary
  // for an EditSchemeSection and hides the new-scheme SchemeSection; the
  // edited polygons live in Terra Draw (via editingSeed up-prop) and
  // its live geometry flows back through drawnFootprints.
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
          onEditingChange(null)
        }
      })
      .catch(() => {
        if (!cancelled) setSchemes([])
      })
    return () => {
      cancelled = true
    }
  }, [schemesToken, projectId, onEditingChange])

  // Keep selectedSchemeId in sync with the list: if the previously selected
  // scheme disappears (e.g. switched projects, future delete) or no selection
  // has been made yet, default to the newest scheme. Selection that's still
  // present in the list is left alone — switching between two saved schemes
  // must not be clobbered when the array reference changes.
  // Pattern: React's documented "adjusting state on prop change" — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-state-when-a-prop-changes
  const [lastSchemes, setLastSchemes] = useState<Scheme[]>(schemes)
  if (schemes !== lastSchemes) {
    setLastSchemes(schemes)
    if (!selectedSchemeId || !schemes.some((s) => s.id === selectedSchemeId)) {
      setSelectedSchemeId(schemes[0]?.id ?? null)
    }
  }

  // Fetch the per-footprint records for the current scheme and push them
  // up to App so Map renders them as the saved-scheme layer. Re-runs when
  // the current scheme changes or after a save/update bumps schemesToken,
  // so an updated footprint set lands without a workspace reset. Errors
  // collapse to "no footprints rendered" rather than blanking the panel —
  // the saved-scheme summary still renders compliance from the scheme row.
  useEffect(() => {
    if (!currentScheme) {
      // Blank the local footprints state and the App-level static layer
      // when no scheme is current. Same data-fetch reset family as
      // Sidebar/SourcesWorkspace — the synchronous reset before the fetch
      // path isn't covered by the rule's async-callback exception.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentFootprints([])
      onCurrentSchemeFootprints(null)
      return
    }
    let cancelled = false
    void fetchSchemeFootprints(currentScheme.id)
      .then((list) => {
        if (cancelled) return
        setCurrentFootprints(list)
        onCurrentSchemeFootprints(list)
      })
      .catch(() => {
        if (cancelled) return
        setCurrentFootprints([])
        onCurrentSchemeFootprints(null)
      })
    return () => {
      cancelled = true
    }
    // schemesToken triggers a re-fetch after save/update/delete; the id
    // dependency handles the "switched current scheme" case. The full
    // `currentScheme` object isn't a dep on purpose — a new reference for
    // the same id (e.g. unrelated re-render) should not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScheme?.id, schemesToken, onCurrentSchemeFootprints])

  useEffect(() => {
    return () => {
      onCurrentSchemeFootprints(null)
    }
    // intentionally only run on unmount: projectId is the parent key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `onClearFootprints` is referenced in cleanup; declare it via a stable
  // closure so React's exhaustive-deps doesn't trip on the prop callback.
  useEffect(() => {
    return () => {
      // Leaving this project (switch or close) clears the draft footprints
      // so they don't bleed into the next project's workspace. The map
      // polygons are tied to drawnFootprints state via Terra Draw, so
      // wiping the state also wipes the rendered geometry on the next
      // mode/effect tick.
      onClearFootprints()
    }
    // intentionally only run on unmount: projectId is the parent key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleStartEdit(scheme: Scheme) {
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
    // Per-footprint records carry both height_ft and the polygon
    // geometry. Step 4 uses one uniform height across all footprints, so
    // we seed the input with the first footprint's height (falling back
    // to the default if no footprints come back). The per-footprint
    // height UI lands next step.
    const fps = await fetchSchemeFootprints(scheme.id).catch(
      () => [] as SchemeFootprint[],
    )
    setEditingHeight(
      fps[0]?.height_ft != null ? String(fps[0].height_ft) : '25',
    )
    onEditingChange(fps.map((f) => f.footprint))
  }

  function handleCancelEdit() {
    setEditingSchemeId(null)
    setEditingName('')
    setEditingHeight('')
    setEditError(null)
    setSavingEdit(false)
    onEditingChange(null)
  }

  async function handleSaveEdit() {
    if (editingSchemeId === null) return
    const trimmed = editingName.trim()
    const heightFt = Number.parseFloat(editingHeight)
    if (!trimmed || !Number.isFinite(heightFt) || heightFt <= 0) return
    if (drawnFootprints.length === 0) return

    setSavingEdit(true)
    setEditError(null)
    try {
      // Per-row label/height from metaById, with the panel default height
      // and 'Building' as last-resort fallbacks (the reconciliation effect
      // ensures every drawn id has a meta entry, so the fallbacks only
      // fire in pathological cases).
      await updateScheme(
        editingSchemeId,
        trimmed,
        drawnFootprints.map((fp) => {
          const meta = metaById[String(fp.id)]
          return {
            geojson: fp.geometry,
            height_ft: meta?.height_ft ?? heightFt,
            label: meta?.label ?? 'Building',
          }
        }),
      )
      // Preserve the current selection: an update doesn't change created_at,
      // so the scheme's position in the desc list is stable.
      postRefetchActionRef.current = 'preserve'
      setSchemesToken((n) => n + 1)
      // Hand the edited geometry to App's static-layer prop in the same
      // batch as the editing teardown. Without this, the saved-scheme
      // layer would reappear (because editingSeed flipped to null) showing
      // the pre-edit geometry until the async refetch lands — a visible
      // snap-back. The footprint_sf is computed client-side from the
      // GeoJSON polygon area; the next refetch will overwrite this with
      // the server-side PostGIS value.
      onCurrentSchemeFootprints(
        drawnFootprints.map((fp, i) => {
          const meta = metaById[String(fp.id)]
          return {
            id: String(fp.id),
            scheme_id: editingSchemeId,
            ordinal: i,
            label: meta?.label ?? `Building ${i + 1}`,
            use_code: null,
            height_ft: meta?.height_ft ?? heightFt,
            footprint: fp.geometry,
            footprint_sf: footprintSquareFeet(fp.geometry),
          }
        }),
      )
      onEditingChange(null)
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
        onEditingChange(null)
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
                onStartEdit={() => void handleStartEdit(currentScheme)}
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
              editedFootprints={drawnFootprints}
              saving={savingEdit}
              error={editError}
              onNameChange={setEditingName}
              onHeightChange={setEditingHeight}
              onSave={() => void handleSaveEdit()}
              onCancel={handleCancelEdit}
              onArmDraw={onArmDraw}
              metaById={metaById}
              selectedFootprintId={selectedFootprintId}
              onLabelChange={handleFootprintLabel}
              onFootprintHeightChange={handleFootprintHeight}
              onSelectFootprint={onSelectFootprint}
              onRemoveFootprint={onRemoveFootprint}
            />
          ) : (
            <SavedSchemeSummary
              key={currentScheme.id}
              scheme={currentScheme}
              footprints={currentFootprints}
              selectedSavedFootprintIds={selectedSavedFootprintIds}
              onToggleSavedFootprint={onToggleSavedFootprint}
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
          onArmDraw={onArmDraw}
          drawnFootprints={drawnFootprints}
          hasSavedScheme={currentScheme !== null}
          onSchemeSaved={() => {
            postRefetchActionRef.current = 'newest'
            setSchemesToken((n) => n + 1)
          }}
          metaById={metaById}
          selectedFootprintId={selectedFootprintId}
          onLabelChange={handleFootprintLabel}
          onHeightChange={handleFootprintHeight}
          onSelectFootprint={onSelectFootprint}
          onRemoveFootprint={onRemoveFootprint}
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
  onArmDraw,
  drawnFootprints,
  onClearFootprints,
  onCurrentSchemeFootprints,
  onEditingChange,
  onSelectFootprint,
  onRemoveFootprint,
  selectedFootprintId,
  selectedSavedFootprintIds,
  onToggleSavedFootprint,
}: ProjectWorkspaceProps) {
  const [expanded, setExpanded] = useState(false)

  // Switching to a *different* project resets to docked; toggling expanded on
  // the SAME project must not change LoadedProjectWorkspace's identity, so the
  // already-fetched context survives the toggle (no refetch, no loading flash).
  // Pattern: React's documented "adjusting state on prop change" — see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-state-when-a-prop-changes
  // The compare-and-set during render lets React detect the state mismatch and
  // re-render synchronously without committing the stale UI; cheaper than an
  // effect and avoids the cascading-render lint.
  const [lastProjectId, setLastProjectId] = useState<string | null>(projectId)
  if (projectId !== lastProjectId) {
    setLastProjectId(projectId)
    setExpanded(false)
  }

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
              onArmDraw={onArmDraw}
              drawnFootprints={drawnFootprints}
              onClearFootprints={onClearFootprints}
              onCurrentSchemeFootprints={onCurrentSchemeFootprints}
              onEditingChange={onEditingChange}
              onSelectFootprint={onSelectFootprint}
              onRemoveFootprint={onRemoveFootprint}
              selectedFootprintId={selectedFootprintId}
              selectedSavedFootprintIds={selectedSavedFootprintIds}
              onToggleSavedFootprint={onToggleSavedFootprint}
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
