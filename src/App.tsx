import { useCallback, useEffect, useState } from 'react'
import { Header, type AppMode } from './components/Header'
import { Map } from './components/Map'
import { ProjectModal } from './components/ProjectModal'
import { ProjectWorkspace } from './components/ProjectWorkspace'
import { Sidebar } from './components/Sidebar'
import { SourcesWorkspace } from './components/SourcesWorkspace'
import { SourceUploadModal } from './components/SourceUploadModal'
import { fetchAllParcels } from './lib/data'
import type { JurisdictionRef, Parcel } from './lib/types'
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
  const [drawnFootprint, setDrawnFootprint] = useState<GeoJSON.Polygon | null>(
    null,
  )
  // Most-recent saved scheme's footprint, lifted from the workspace so the
  // Map can render it as a persistent layer (separate from the Terra Draw
  // draft). Null when no project is open or the project has no schemes yet.
  const [currentSchemeFootprint, setCurrentSchemeFootprint] =
    useState<GeoJSON.Polygon | null>(null)
  // The polygon currently loaded into Terra Draw for in-place editing. When
  // non-null, Map injects it into the draw instance and drops into select
  // mode; the static saved-scheme layer is suppressed so the user doesn't
  // see two copies. The workspace owns the edit lifecycle and pushes the
  // initial geometry up (start), then null (save/cancel).
  const [editingFootprint, setEditingFootprint] =
    useState<GeoJSON.Polygon | null>(null)

  const loadParcels = useCallback(async () => {
    try {
      const parcels = await fetchAllParcels()
      setAllParcels(parcels)
    } catch {
      setAllParcels([])
    }
  }, [])

  useEffect(() => {
    void loadParcels()
  }, [loadParcels])

  const handleToggleDraw = useCallback((next: boolean) => {
    setDrawMode(next)
  }, [])

  const handleClearFootprint = useCallback(() => {
    setDrawnFootprint(null)
  }, [])

  const handleFootprintDrawn = useCallback((geom: GeoJSON.Polygon) => {
    setDrawnFootprint(geom)
  }, [])

  const handleCurrentSchemeFootprint = useCallback(
    (footprint: GeoJSON.Polygon | null) => {
      setCurrentSchemeFootprint(footprint)
    },
    [],
  )

  // Workspace → App: start (footprint) or stop (null) editing the current
  // saved scheme. Setting both pieces of state in lockstep keeps Map's
  // editing-load effect and the workspace's "live edited geometry" view in
  // sync: editingFootprint seeds Terra Draw once; drawnFootprint then
  // tracks every drag/vertex update via the existing change pipeline.
  const handleEditingFootprintChange = useCallback(
    (footprint: GeoJSON.Polygon | null) => {
      setEditingFootprint(footprint)
      setDrawnFootprint(footprint)
    },
    [],
  )

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
                mode={mode}
                selectedParcelId={selectedParcelId}
                onParcelClick={setSelectedParcelId}
                onProjectClick={setSelectedProjectId}
                refreshProjectsToken={projectsToken}
                drawMode={drawMode}
                onFootprintDrawn={handleFootprintDrawn}
                // Suppress the static saved-scheme polygon for the scheme
                // that's currently being edited (its geometry lives in
                // Terra Draw while editing). Otherwise the user would see
                // two stacked polygons until they saved.
                savedSchemeFootprint={
                  editingFootprint ? null : currentSchemeFootprint
                }
                editingFootprint={editingFootprint}
              />
            </div>
            {mode === 'parcels' ? (
              <Sidebar
                selectedParcelId={selectedParcelId}
                allParcels={allParcels}
              />
            ) : (
              <ProjectWorkspace
                projectId={selectedProjectId}
                onClose={() => setSelectedProjectId(null)}
                drawMode={drawMode}
                onToggleDraw={handleToggleDraw}
                drawnFootprint={drawnFootprint}
                onClearFootprint={handleClearFootprint}
                onCurrentSchemeFootprint={handleCurrentSchemeFootprint}
                onEditingFootprintChange={handleEditingFootprintChange}
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
