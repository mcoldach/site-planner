import { useCallback, useEffect, useState } from 'react'
import { Header, type AppMode } from './components/Header'
import { Map } from './components/Map'
import { ProjectModal } from './components/ProjectModal'
import { ProjectWorkspace } from './components/ProjectWorkspace'
import { Sidebar } from './components/Sidebar'
import { fetchAllParcels } from './lib/data'
import type { Parcel } from './lib/types'
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
  const [drawMode, setDrawMode] = useState(false)
  const [drawnFootprint, setDrawnFootprint] = useState<GeoJSON.Polygon | null>(
    null,
  )
  // Most-recent saved scheme's footprint, lifted from the workspace so the
  // Map can render it as a persistent layer (separate from the Terra Draw
  // draft). Null when no project is open or the project has no schemes yet.
  const [currentSchemeFootprint, setCurrentSchemeFootprint] =
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
      />

      <main className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Map
            mode={mode}
            selectedParcelId={selectedParcelId}
            onParcelClick={setSelectedParcelId}
            onProjectClick={setSelectedProjectId}
            refreshProjectsToken={projectsToken}
            drawMode={drawMode}
            onFootprintDrawn={handleFootprintDrawn}
            savedSchemeFootprint={currentSchemeFootprint}
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
          />
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
    </div>
  )
}

export default App
