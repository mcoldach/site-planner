import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search as SearchIcon, X } from 'lucide-react'
import { lookupParcelByApn } from '../lib/data'
import type { Parcel } from '../lib/types'

type ParcelSearchProps = {
  parcels: Parcel[]
  selectedParcelId: string | null
  onSelect: (parcelId: string | null) => void
  onLookupComplete: () => Promise<void> | void
}

function parcelDisplayValue(parcel: Parcel): string {
  return parcel.label ?? parcel.source_apn
}

function parcelMatchesQuery(parcel: Parcel, query: string): boolean {
  const q = query.toLowerCase()
  if (parcel.source_apn.toLowerCase().includes(q)) return true
  if ((parcel.label ?? '').toLowerCase().includes(q)) return true
  if ((parcel.zone_district_code ?? '').toLowerCase().includes(q)) return true
  return false
}

export function ParcelSearch({
  parcels,
  selectedParcelId,
  onSelect,
  onLookupComplete,
}: ParcelSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [lookupStatus, setLookupStatus] = useState<
    'idle' | 'searching' | 'not-found'
  >('idle')
  const [lookupError, setLookupError] = useState<string | null>(null)

  const selectedParcel = useMemo(
    () => parcels.find((p) => p.id === selectedParcelId) ?? null,
    [parcels, selectedParcelId],
  )

  useEffect(() => {
    if (selectedParcel) {
      setQuery(parcelDisplayValue(selectedParcel))
    }
  }, [selectedParcel])

  const filteredParcels = useMemo(() => {
    const trimmed = query.trim()
    if (!trimmed) return parcels
    return parcels.filter((p) => parcelMatchesQuery(p, trimmed))
  }, [parcels, query])

  useEffect(() => {
    setHighlightedIndex(-1)
  }, [filteredParcels])

  const closeDropdown = useCallback(() => {
    setDropdownOpen(false)
    setHighlightedIndex(-1)
  }, [])

  const selectParcel = useCallback(
    (parcel: Parcel) => {
      onSelect(parcel.id)
      setQuery(parcelDisplayValue(parcel))
      closeDropdown()
    },
    [onSelect, closeDropdown],
  )

  const handleClear = useCallback(() => {
    setQuery('')
    onSelect(null)
    closeDropdown()
    inputRef.current?.focus()
  }, [onSelect, closeDropdown])

  const handleRemoteLookup = useCallback(async () => {
    const apn = query.trim()
    if (!apn) return

    setLookupStatus('searching')
    setLookupError(null)

    try {
      const result = await lookupParcelByApn(apn)
      if (result.found) {
        await onLookupComplete()
        onSelect(result.parcelId)
        setQuery(apn)
        setLookupStatus('idle')
        closeDropdown()
      } else {
        setLookupStatus('not-found')
      }
    } catch (err) {
      setLookupError(
        err instanceof Error ? err.message : 'Lookup failed',
      )
      setLookupStatus('idle')
    }
  }, [query, onLookupComplete, onSelect, closeDropdown])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!dropdownOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setDropdownOpen(true)
      return
    }

    if (!dropdownOpen) return

    const count = filteredParcels.length
    const hasEmptyState = query.trim().length > 0 && count === 0

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (hasEmptyState) return
      setHighlightedIndex((i) => (i < count - 1 ? i + 1 : i === -1 ? 0 : i))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (hasEmptyState) return
      setHighlightedIndex((i) => (i > 0 ? i - 1 : i === -1 ? count - 1 : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (hasEmptyState) {
        void handleRemoteLookup()
        return
      }
      const index = highlightedIndex >= 0 ? highlightedIndex : 0
      const parcel = filteredParcels[index]
      if (parcel) selectParcel(parcel)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeDropdown()
      inputRef.current?.blur()
    }
  }

  const emptyStateMessage = useMemo(() => {
    const trimmed = query.trim()
    if (lookupError) return lookupError
    if (lookupStatus === 'searching') {
      return `Searching county records for ${trimmed}…`
    }
    if (lookupStatus === 'not-found') {
      return `No parcel found for APN ${trimmed}.`
    }
    return 'No seeded match — press Enter to search county records.'
  }, [query, lookupStatus, lookupError])

  return (
    <div className="relative w-full">
      <label htmlFor="parcel-search" className="sr-only">
        Address or parcel number
      </label>
      <SearchIcon
        className="pointer-events-none absolute left-3 top-1/2 z-10 size-[14px] -translate-y-1/2 text-[var(--color-slate)]"
        aria-hidden
        strokeWidth={2}
      />
      <input
        ref={inputRef}
        id="parcel-search"
        type="search"
        name="q"
        value={query}
        placeholder="Address or parcel number…"
        autoComplete="off"
        className={`hairline w-full rounded-sm bg-white py-2 pl-9 font-sans text-sm text-[var(--color-ink)] placeholder:text-[var(--color-slate)] ${
          selectedParcelId ? 'pr-9' : 'pr-3'
        }`}
        onChange={(e) => {
          const value = e.target.value
          setQuery(value)
          setLookupStatus('idle')
          setLookupError(null)
          if (value.length > 0) setDropdownOpen(true)
          if (selectedParcelId) onSelect(null)
        }}
        onFocus={() => setDropdownOpen(true)}
        onBlur={() => {
          window.setTimeout(() => {
            if (document.activeElement !== inputRef.current) {
              closeDropdown()
            }
          }, 0)
        }}
        onKeyDown={handleKeyDown}
      />
      {selectedParcelId ? (
        <button
          type="button"
          aria-label="Clear parcel selection"
          className="absolute right-2 top-1/2 z-10 -translate-y-1/2 p-0.5 text-[var(--color-slate)] hover:text-[var(--color-ink)]"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleClear}
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      ) : null}

      {dropdownOpen ? (
        <ul
          role="listbox"
          className="hairline absolute left-0 right-0 top-full z-20 mt-1 max-h-[280px] overflow-y-auto border bg-[var(--color-canvas)]"
        >
          {query.trim().length > 0 && filteredParcels.length === 0 ? (
            <li className="px-3 py-2 font-sans text-sm italic text-[var(--color-slate)]">
              {emptyStateMessage}
            </li>
          ) : (
            filteredParcels.map((parcel, index) => {
              const isLast = index === filteredParcels.length - 1
              const isHighlighted = index === highlightedIndex
              const zone = parcel.zone_district_code ?? '—'
              return (
                <li
                  key={parcel.id}
                  role="option"
                  aria-selected={isHighlighted}
                  className={`cursor-pointer px-3 py-2 hover:bg-[var(--color-accent-wash)] ${
                    isHighlighted ? 'bg-[var(--color-accent-wash)]' : ''
                  } ${isLast ? '' : 'border-b hairline'}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => selectParcel(parcel)}
                >
                  <div className="font-sans text-sm text-[var(--color-ink)]">
                    {parcel.label ? (
                      parcel.label
                    ) : (
                      <span className="italic text-[var(--color-slate)]">(no label)</span>
                    )}
                  </div>
                  <div className="font-mono text-xs text-[var(--color-slate)]">
                    {parcel.source_apn} · {zone}
                  </div>
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
