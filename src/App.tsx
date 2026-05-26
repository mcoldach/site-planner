import { useCallback, useEffect, useState } from 'react'
import { Header, type AppMode } from './components/Header'
import { Map } from './components/Map'
import { ProjectsSidebar } from './components/ProjectsSidebar'
import { Sidebar } from './components/Sidebar'
import { fetchAllParcels } from './lib/data'
import type { Parcel } from './lib/types'

function App() {
  const [mode, setMode] = useState<AppMode>('parcels')
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null)
  const [allParcels, setAllParcels] = useState<Parcel[]>([])

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

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header
        mode={mode}
        onModeChange={setMode}
        parcels={allParcels}
        selectedParcelId={selectedParcelId}
        onSelectParcel={setSelectedParcelId}
        onLookupComplete={loadParcels}
        onNewProject={() => {
          // Placeholder — project creation lands in a later phase.
        }}
      />

      <main className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          <Map
            selectedParcelId={selectedParcelId}
            onParcelClick={setSelectedParcelId}
          />
        </div>
        {mode === 'parcels' ? (
          <Sidebar
            selectedParcelId={selectedParcelId}
            allParcels={allParcels}
          />
        ) : (
          <ProjectsSidebar />
        )}
      </main>
    </div>
  )
}

export default App
