import { useCallback, useEffect, useState } from 'react'
import { Header, type AppMode } from './components/Header'
import { Map } from './components/Map'
import { ProjectModal } from './components/ProjectModal'
import { ProjectWorkspace } from './components/ProjectWorkspace'
import { Sidebar } from './components/Sidebar'
import { SourcesWorkspace } from './components/SourcesWorkspace'
import { SourceUploadModal } from './components/SourceUploadModal'
import { fetchAllParcels } from './lib/data'
import type {
  DrawnFootprint,
  JurisdictionRef,
  Parcel,
  SchemeFootprint,
} from './lib/types'
import type * as GeoJSON from 'geojson'

function App() {
  const [mode, setMode] = useState<AppMode>('parcels')
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  )
  const [allParcels, setAllParcels] = useState<Parcel[]>([])
  const [isProjectModalOpen, setProjectModalOpen] = useState(false)
  const [projectsToken, setProjectsToken] = useState(0)
  // Sources mode state. Mirrors the Projects pattern: a modal toggle, a
  // refresh token bumped by the modal on success so the list refetches, and
  // a lifted "current jurisdiction" so the modal knows where the upload
  // lands without needing a callback ref into the workspace.
  const [isSourceUploadOpen, setSourceUploadOpen] = useState(false)
  const [sourcesToken, setSourcesToken] = useState(0)
  const [activeJurisdiction, setActiveJurisdiction] =
    useState<JurisdictionRef | null>(null)
  const [drawMode, setDrawMode] = useState(false)
  // Imperative "arm draw" signal. Bumping this counter tells Map to
  // re-enter polygon mode regardless of the current Terra Draw state.
  // Required because the 'finish' handler in Map drops the instance into
  // 'select' mode after each pad, and the existing mode/drawMode effect
  // only fires on state changes — so re-arming "draw another" needs an
  // explicit token rather than a no-op setDrawMode(true).
  const [drawArmToken, setDrawArmToken] = useState(0)
  // The full set of polygons currently in Terra Draw, emitted in lockstep
  // with every draw/finish/edit/delete. Terra Draw owns live geometry; the
  // app reads it OUT each change but never pushes it back in mid-session.
  // Each entry carries Terra Draw's stable feature id so the workspace can
  // thread identity through saves/edits without losing it across renders.
  const [drawnFootprints, setDrawnFootprints] = useState<DrawnFootprint[]>([])
  // The current saved scheme's footprints (server-issued ids and PostGIS
  // geometry), lifted from the workspace so Map can render them as a
  // persistent layer separate from the Terra Draw draft. Null when no
  // project is open or the project has no schemes yet.
  const [currentSchemeFootprints, setCurrentSchemeFootprints] = useState<
    SchemeFootprint[] | null
  >(null)
  // Seed polygons to load into Terra Draw at the START of an edit session.
  // This is a SEED — the app sets it once, Map injects every polygon, and
  // from that point on Terra Draw owns the geometry and we read it back via
  // drawnFootprints. Setting back to null tears down the editing features.
  const [editingSeed, setEditingSeed] = useState<GeoJSON.Polygon[] | null>(
    null,
  )
  // Imperative panel → Map signals for the per-footprint UI in the
  // workspace. The token bumps tell Map to re-run its select/remove
  // effect; the companion id state carries WHICH footprint to act on at
  // the moment of the bump. Token-based (rather than calling a method on
  // a Map ref) so the contract is unidirectional state + props, matching
  // the existing drawArmToken pattern.
  const [selectFootprintToken, setSelectFootprintToken] = useState(0)
  const [selectFootprintId, setSelectFootprintId] = useState<
    string | number | null
  >(null)
  const [removeFootprintToken, setRemoveFootprintToken] = useState(0)
  const [removeFootprintId, setRemoveFootprintId] = useState<
    string | number | null
  >(null)
  // Map → App: Terra Draw's current selection, reported via its select /
  // deselect events. The workspace renders the matching row's accent
  // highlight from this, so panel ↔ map selection stays in lockstep
  // without the workspace having to track selection itself.
  const [selectedFootprintId, setSelectedFootprintId] = useState<
    string | number | null
  >(null)
  // Saved-scheme selection is multi-target: clicking a building (panel
  // row or map polygon) toggles its id in this set, so the user can
  // light up several saved footprints at once. Distinct from
  // selectedFootprintId, which is the single-target Terra Draw
  // selection used by the edit-mode flows.
  const [selectedSavedFootprintIds, setSelectedSavedFootprintIds] = useState<
    Set<string | number>
  >(new Set())

  const loadParcels = useCallback(async () => {
    try {
      const parcels = await fetchAllParcels()
      setAllParcels(parcels)
    } catch {
      setAllParcels([])
    }
  }, [])

  useEffect(() => {
    // Canonical mount-time data fetch. loadParcels is extracted into a
    // useCallback (not inlined) so it can also be re-invoked imperatively
    // after a parcel lookup completes. The "setState in effect" the rule
    // points at is fetched-data flowing into state, which is exactly what
    // effects are for — see React docs on fetching data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadParcels()
  }, [loadParcels])

  const handleToggleDraw = useCallback((next: boolean) => {
    setDrawMode(next)
    // Turning the toggle ON also arms a fresh polygon-mode entry so the
    // user can start drawing immediately. Turning OFF just parks the
    // instance via the mode/drawMode effect — no token bump needed.
    if (next) setDrawArmToken((n) => n + 1)
  }, [])

  // "Draw another" affordance: re-arm polygon mode without toggling
  // drawMode (which is already true). Used by the workspace's secondary
  // button after a pad finishes and by EditSchemeSection so the user can
  // add a footprint to a scheme they're editing.
  const handleArmDraw = useCallback(() => {
    setDrawMode(true)
    setDrawArmToken((n) => n + 1)
  }, [])

  const handleClearFootprints = useCallback(() => {
    setDrawnFootprints([])
  }, [])

  const handleFootprintsChanged = useCallback((fps: DrawnFootprint[]) => {
    setDrawnFootprints(fps)
  }, [])

  const handleCurrentSchemeFootprints = useCallback(
    (fps: SchemeFootprint[] | null) => {
      setCurrentSchemeFootprints(fps)
    },
    [],
  )

  // Workspace → App: start (seed polygons) or stop (null) editing the
  // current saved scheme. On START we ONLY set the seed; Map will inject
  // those polygons into Terra Draw and then immediately emit a real
  // DrawnFootprint[] (with Terra Draw ids) via onFootprintsChanged — at
  // which point drawnFootprints catches up. On STOP we also clear
  // drawnFootprints so the workspace's draft view doesn't keep showing
  // the just-edited polygons after save/cancel.
  const handleEditingChange = useCallback(
    (seeds: GeoJSON.Polygon[] | null) => {
      setEditingSeed(seeds)
      if (seeds === null) {
        setDrawnFootprints([])
      }
    },
    [],
  )

  // Set the id first, then bump the token: Map's select effect is keyed
  // only on the token (so re-selecting the same id fires it again), and
  // reads the id from a latest-value ref. React batches these in a single
  // render so the ref always carries the id captured at the bump.
  // Toggle: if the caller passes the currently-selected id, clear; otherwise
  // select the new one. The functional updater reads the freshest selection
  // so a rapid double-click doesn't race with a previous setState. Map's
  // effect on the bump interprets null as "deselect whatever's selected on
  // the map" — the deselect event listener there will then report null up
  // and clear `selectedFootprintId`, closing the loop.
  // Writes BOTH states because the panel's selection request needs two
  // paths: (1) the Terra Draw command path (selectFootprintId + token)
  // for editable footprints in draft/edit mode, and (2) the MapLibre
  // truth-state path (selectedFootprintId) which the saved-scheme-
  // selected layer's setFilter effect reads from. Without (2), saved-
  // scheme panel clicks would silently no-op — Terra Draw's
  // selectFeature only knows about features in its own store, and
  // saved-scheme footprints render as plain MapLibre layers (not Terra
  // Draw features). For editable footprints, the (2) write is also
  // harmless: Terra Draw's 'select' listener will fire (path 1) and
  // overwrite selectedFootprintId with the same id.
  // Panel-driven selection. Always SETS (does not toggle) — re-clicking
  // the same building keeps it selected. The row component owns its own
  // expand/collapse state, so re-clicking still feels responsive via the
  // expansion toggle there. Deselection-by-clicking-elsewhere goes
  // through handleSelectedFootprintIdChanged (the map's event channel),
  // not this handler. Writes to both selectFootprintId (the COMMAND state
  // for editable footprints in Terra Draw) and selectedFootprintId (the
  // TRUTH state that drives the MapLibre saved-scheme-selected layer).
  const handleSelectFootprint = useCallback((id: string | number) => {
    setSelectFootprintId(id)
    setSelectFootprintToken((n) => n + 1)
    setSelectedFootprintId(id)
  }, [])

  const handleRemoveFootprint = useCallback((id: string | number) => {
    setRemoveFootprintId(id)
    setRemoveFootprintToken((n) => n + 1)
  }, [])

  const handleSelectedFootprintIdChanged = useCallback(
    (id: string | number | null) => {
      setSelectedFootprintId(id)
    },
    [],
  )

  // Saved-scheme selection is multi: clicking a building (panel row or
  // map polygon) toggles its id in the set. Distinct from
  // handleSelectedFootprintIdChanged which is for edit-mode single-select.
  const handleToggleSavedFootprintId = useCallback(
    (id: string | number) => {
      setSelectedSavedFootprintIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [],
  )

  // Saved-scheme map background click: clear all selections.
  const handleClearSavedFootprints = useCallback(() => {
    setSelectedSavedFootprintIds(new Set())
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        mode={mode}
        onModeChange={setMode}
        parcels={allParcels}
        selectedParcelId={selectedParcelId}
        onSelectParcel={setSelectedParcelId}
        onLookupComplete={loadParcels}
        onNewProject={() => setProjectModalOpen(true)}
        onUploadSource={() => setSourceUploadOpen(true)}
      />

      <main className="flex min-h-0 flex-1">
        {mode === 'sources' ? (
          // Sources mode has no map — the truth-engine module is a
          // document/citation surface, not a spatial one. Render the
          // workspace full-width so the editorial list breathes.
          <SourcesWorkspace
            refreshToken={sourcesToken}
            onJurisdictionChange={setActiveJurisdiction}
          />
        ) : (
          <>
            <div className="relative min-h-0 min-w-0 flex-1">
              <Map
                parcels={allParcels}
                mode={mode}
                selectedParcelId={selectedParcelId}
                onParcelClick={setSelectedParcelId}
                onProjectClick={setSelectedProjectId}
                refreshProjectsToken={projectsToken}
                drawMode={drawMode}
                drawArmToken={drawArmToken}
                onFootprintsChanged={handleFootprintsChanged}
                // Suppress the static saved-scheme layer while an edit
                // session is in flight (the scheme's geometry lives in
                // Terra Draw then). Otherwise the user would see two
                // stacked sets of polygons until they saved.
                savedSchemeFootprints={
                  editingSeed ? null : currentSchemeFootprints
                }
                editingSeed={editingSeed}
                selectFootprintToken={selectFootprintToken}
                selectFootprintId={selectFootprintId}
                selectedFootprintId={selectedFootprintId}
                selectedSavedFootprintIds={selectedSavedFootprintIds}
                onToggleSavedFootprintId={handleToggleSavedFootprintId}
                onClearSavedFootprints={handleClearSavedFootprints}
                removeFootprintToken={removeFootprintToken}
                removeFootprintId={removeFootprintId}
                onSelectedFootprintIdChanged={handleSelectedFootprintIdChanged}
              />
            </div>
            {mode === 'parcels' ? (
              <Sidebar
                key={selectedParcelId ?? 'empty'}
                selectedParcelId={selectedParcelId}
              />
            ) : (
              <ProjectWorkspace
                projectId={selectedProjectId}
                onClose={() => setSelectedProjectId(null)}
                onProjectChanged={() => setProjectsToken((n) => n + 1)}
                drawMode={drawMode}
                onToggleDraw={handleToggleDraw}
                onArmDraw={handleArmDraw}
                drawnFootprints={drawnFootprints}
                onClearFootprints={handleClearFootprints}
                onCurrentSchemeFootprints={handleCurrentSchemeFootprints}
                onEditingChange={handleEditingChange}
                onSelectFootprint={handleSelectFootprint}
                onRemoveFootprint={handleRemoveFootprint}
                selectedFootprintId={selectedFootprintId}
                selectedSavedFootprintIds={selectedSavedFootprintIds}
                onToggleSavedFootprint={handleToggleSavedFootprintId}
              />
            )}
          </>
        )}
      </main>

      <ProjectModal
        isOpen={isProjectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        onCreated={() => {
          setProjectsToken((n) => n + 1)
        }}
        parcels={allParcels}
        onLookupComplete={loadParcels}
      />

      <SourceUploadModal
        isOpen={isSourceUploadOpen}
        onClose={() => setSourceUploadOpen(false)}
        jurisdiction={activeJurisdiction}
        onUploaded={() => {
          setSourcesToken((n) => n + 1)
        }}
      />
    </div>
  )
}

export default App
