import { ArrowUpRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ClaimsList } from './ClaimsList'
import { fetchParcelWithJurisdictionAndClaims } from '../lib/data'
import type {
  AuthorityType,
  Claim,
  Jurisdiction,
  Parcel,
  ParcelContext,
} from '../lib/types'

type SidebarProps = {
  selectedParcelId: string | null
  allParcels: Parcel[]
}

function HairlineRule() {
  return <div className="my-4 border-t border-[var(--color-fog)]" aria-hidden />
}

function authorityTypeLabel(type: AuthorityType): string {
  switch (type) {
    case 'municipal':
      return 'Municipal (city)'
    case 'county_unincorporated':
      return 'County — unincorporated territory'
    default:
      return type
  }
}

function formatRetrievedDate(iso: string): string {
  return iso.slice(0, 10)
}

type ParcelHeaderProps = {
  parcel: Parcel
}

function ParcelHeader({ parcel }: ParcelHeaderProps) {
  return (
    <header>
      <h2 className="font-serif text-lg text-[var(--color-ink)]">
        {parcel.label ?? parcel.source_apn}
      </h2>
      <p className="mt-1 font-mono text-xs text-[var(--color-slate)]">
        APN: {parcel.source_apn} &nbsp;&nbsp;·&nbsp;&nbsp; Zone:{' '}
        {parcel.zone_district_code ?? '—'}
      </p>
    </header>
  )
}

type JurisdictionBlockProps = {
  jurisdiction: Jurisdiction
}

function JurisdictionBlock({ jurisdiction }: JurisdictionBlockProps) {
  const codeLine = (
    <>
      Code:{' '}
      {jurisdiction.code_home_url && jurisdiction.code_label ? (
        <a
          href={jurisdiction.code_home_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-slate)] hover:text-[var(--color-accent)] hover:underline"
        >
          {jurisdiction.code_label}
          <ArrowUpRight
            className="ml-0.5 inline-block align-text-top"
            size={10}
            aria-hidden
          />
        </a>
      ) : (
        <span>{jurisdiction.code_label ?? '—'}</span>
      )}
      {jurisdiction.current_code_version
        ? ` · ${jurisdiction.current_code_version}`
        : null}
    </>
  )

  return (
    <section>
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        GOVERNED BY
      </p>
      <p className="mt-1 font-serif text-base text-[var(--color-ink)]">
        {jurisdiction.name}
      </p>
      <p className="mt-0.5 font-sans text-xs text-[var(--color-slate)]">
        {authorityTypeLabel(jurisdiction.authority_type)}
      </p>
      <p className="mt-1 font-mono text-xs text-[var(--color-slate)]">
        {codeLine}
      </p>
    </section>
  )
}

type ProvenanceFooterProps = {
  claims: Claim[]
  parcelRetrievedAt: string
}

function ProvenanceFooter({ claims, parcelRetrievedAt }: ProvenanceFooterProps) {
  const uniqueSourceCount = useMemo(
    () => new Set(claims.map((c) => c.source_snapshot.url)).size,
    [claims],
  )

  return (
    <footer className="mt-2">
      <p className="font-mono text-[10px] text-[var(--color-slate)]">
        {claims.length} {claims.length === 1 ? 'claim' : 'claims'} ·{' '}
        {uniqueSourceCount} {uniqueSourceCount === 1 ? 'source' : 'sources'} ·
        retrieved {formatRetrievedDate(parcelRetrievedAt)}
      </p>
      <p className="mt-1 text-sm italic text-[var(--color-mist)]">
        Feasibility-grade · not a substitute for a licensed survey or legal
        opinion
      </p>
    </footer>
  )
}

function EmptyState() {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        SELECTED PARCEL
      </p>
      <p className="mt-3 text-sm italic text-[var(--color-mist)]">
        Search or click a parcel to view jurisdiction and cited rules.
      </p>
    </div>
  )
}

export function Sidebar({ selectedParcelId, allParcels: _allParcels }: SidebarProps) {
  const [context, setContext] = useState<ParcelContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedParcelId) {
      setContext(null)
      setError(null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)
    setContext(null)

    void fetchParcelWithJurisdictionAndClaims(selectedParcelId)
      .then((data) => {
        if (!cancelled) setContext(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load parcel context',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedParcelId])

  return (
    <aside className="w-[380px] shrink-0 overflow-y-auto border-l border-[var(--color-fog)] bg-[var(--color-paper)] px-6 py-6">
      {!selectedParcelId ? (
        <EmptyState />
      ) : loading ? (
        <p className="text-sm text-[var(--color-slate)]">loading…</p>
      ) : error ? (
        <p className="text-sm text-[var(--color-slate)]">{error}</p>
      ) : context ? (
        <>
          <ParcelHeader parcel={context.parcel} />
          <HairlineRule />
          {context.jurisdiction ? (
            <JurisdictionBlock jurisdiction={context.jurisdiction} />
          ) : (
            <p className="font-sans text-xs text-[var(--color-slate)]">
              No jurisdiction resolved for this parcel.
            </p>
          )}
          <HairlineRule />
          <ClaimsList claims={context.claims} />
          <HairlineRule />
          <ProvenanceFooter
            claims={context.claims}
            parcelRetrievedAt={context.parcel.retrieved_at}
          />
        </>
      ) : null}
    </aside>
  )
}
