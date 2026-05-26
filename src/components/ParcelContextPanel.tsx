import { ArrowUpRight } from 'lucide-react'
import { useMemo } from 'react'
import { ClaimsList } from './ClaimsList'
import { ZoningCoverage } from './ZoningCoverage'
import type {
  AuthorityType,
  Claim,
  Classification,
  Jurisdiction,
  Parcel,
  ParcelContext,
  ZoneCode,
} from '../lib/types'

// Pure-presentation panel. Renders the resolved parcel context exactly the way
// Sidebar used to render it inline, but takes the context as props so it can be
// reused inside Projects-mode workspaces. No fetching, no selection state — the
// caller resolves the context and hands it in shaped as `ParcelContext` so
// `<ParcelContextPanel {...context} />` works.
type ParcelContextPanelProps = ParcelContext

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
  baseCodes: ZoneCode[]
}

function ParcelHeader({ parcel, baseCodes }: ParcelHeaderProps) {
  const codes = baseCodes.map((b) => b.code)
  const zoneLabel = codes.length >= 2 ? 'Zones:' : 'Zone:'
  const zoneValue =
    codes.length === 0
      ? (parcel.zone_district_code ?? '—')
      : codes.length === 1
        ? codes[0]
        : codes.join(', ')

  return (
    <header>
      <h2 className="font-serif text-lg text-[var(--color-ink)]">
        {parcel.label ?? parcel.source_apn}
      </h2>
      <p className="mt-1 font-mono text-xs text-[var(--color-slate)]">
        APN: {parcel.source_apn} &nbsp;&nbsp;·&nbsp;&nbsp; {zoneLabel}{' '}
        {zoneValue}
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

function hasZoningCoverage(classification: Classification): boolean {
  return (
    classification.overlay_codes.length > 0 ||
    classification.unclassified_codes.length > 0
  )
}

export function ParcelContextPanel({
  parcel,
  jurisdiction,
  classification,
  claims,
}: ParcelContextPanelProps) {
  return (
    <>
      <ParcelHeader parcel={parcel} baseCodes={classification.base_codes} />
      <HairlineRule />
      {jurisdiction ? (
        <JurisdictionBlock jurisdiction={jurisdiction} />
      ) : (
        <p className="font-sans text-xs text-[var(--color-slate)]">
          No jurisdiction resolved for this parcel.
        </p>
      )}
      {hasZoningCoverage(classification) ? (
        <>
          <HairlineRule />
          <ZoningCoverage classification={classification} />
        </>
      ) : null}
      <HairlineRule />
      <ClaimsList claims={claims} baseCodes={classification.base_codes} />
      <HairlineRule />
      <ProvenanceFooter
        claims={claims}
        parcelRetrievedAt={parcel.retrieved_at}
      />
    </>
  )
}
