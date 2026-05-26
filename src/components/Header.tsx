import { ParcelSearch } from './ParcelSearch'
import type { Parcel } from '../lib/types'
import { useAuth } from '../lib/auth'

export type AppMode = 'projects' | 'parcels'

type HeaderProps = {
  mode: AppMode
  onModeChange: (mode: AppMode) => void
  parcels: Parcel[]
  selectedParcelId: string | null
  onSelectParcel: (id: string | null) => void
  onLookupComplete: () => void | Promise<void>
  onNewProject: () => void
}

type ModeNavProps = {
  mode: AppMode
  onModeChange: (mode: AppMode) => void
}

function ModeNav({ mode, onModeChange }: ModeNavProps) {
  const items: { id: AppMode; label: string }[] = [
    { id: 'projects', label: 'Projects' },
    { id: 'parcels', label: 'Parcels' },
  ]

  return (
    <nav aria-label="Workspace mode" className="flex items-center gap-6">
      {items.map((item) => {
        const isActive = mode === item.id
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onModeChange(item.id)}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'font-mono text-[11px] uppercase tracking-[0.1em] leading-none',
              'border-b-2 pb-1',
              'transition-colors',
              isActive
                ? 'border-[var(--color-accent)] text-[var(--color-ink)]'
                : 'border-transparent text-[var(--color-slate)] hover:text-[var(--color-graphite)]',
            ].join(' ')}
          >
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

function NewProjectControl({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-xs uppercase tracking-[0.08em] text-[var(--color-accent)] hover:text-[var(--color-accent-soft)]"
    >
      <span aria-hidden className="mr-1">
        +
      </span>
      Project
    </button>
  )
}

export function Header({
  mode,
  onModeChange,
  parcels,
  selectedParcelId,
  onSelectParcel,
  onLookupComplete,
  onNewProject,
}: HeaderProps) {
  const { signOut } = useAuth()

  return (
    <header className="hairline flex h-14 shrink-0 items-center border-t-0 border-l-0 border-r-0 bg-[var(--color-canvas)] px-6">
      <h1 className="shrink-0 font-serif text-base leading-none text-[var(--color-ink)]">
        Prospect
      </h1>

      <div className="ml-12 shrink-0">
        <ModeNav mode={mode} onModeChange={onModeChange} />
      </div>

      <div className="ml-auto flex shrink-0 items-center pl-6">
        {mode === 'parcels' ? (
          <div className="w-[min(480px,40vw)] min-w-[220px]">
            <ParcelSearch
              parcels={parcels}
              selectedParcelId={selectedParcelId}
              onSelect={onSelectParcel}
              onLookupComplete={onLookupComplete}
            />
          </div>
        ) : (
          <NewProjectControl onClick={onNewProject} />
        )}

        <button
          type="button"
          onClick={() => void signOut()}
          className="ml-6 font-mono text-[11px] text-[var(--color-slate)] hover:text-[var(--color-graphite)]"
        >
          Sign out
        </button>
      </div>
    </header>
  )
}
