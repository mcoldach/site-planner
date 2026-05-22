import { ArrowUpRight } from 'lucide-react'
import { formatClaimValue, resolveClaimLabel } from '../lib/rule-catalog'
import type { Claim } from '../lib/types'

type ClaimCardProps = {
  claim: Claim
}

export function ClaimCard({ claim }: ClaimCardProps) {
  const { display, unit } = formatClaimValue(claim)
  const citeUrl = claim.section_url ?? claim.source_snapshot.url
  const isProse = display.length > 25

  return (
    <div className="py-3 transition-colors duration-150 hover:bg-[var(--color-accent-wash)]">
      <p className="font-sans text-xs text-[var(--color-ink)]">
        {resolveClaimLabel(claim)}
      </p>

      <div className="mt-1 flex flex-row items-baseline">
        <span
          className={
            isProse
              ? 'font-serif text-lg leading-snug text-[var(--color-ink)]'
              : 'font-serif text-3xl leading-none text-[var(--color-ink)]'
          }
          style={isProse ? undefined : { fontVariantNumeric: 'tabular-nums' }}
        >
          {display}
        </span>
        {unit ? (
          <span className="ml-1 font-mono text-xs text-[var(--color-slate)]">
            {unit}
          </span>
        ) : null}
      </div>

      <div className="mt-2 border-t border-[var(--color-fog)] pt-1">
        <p className="font-mono text-[11px] text-[var(--color-graphite)]">
          {claim.section_ref}
        </p>
        <p className="font-mono text-[11px]">
          {citeUrl ? (
            <a
              href={citeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-slate)] hover:text-[var(--color-accent)] hover:underline"
            >
              {claim.source_snapshot.title}
              <ArrowUpRight
                className="ml-0.5 inline-block align-text-top"
                size={10}
                aria-hidden
              />
            </a>
          ) : (
            <span className="text-[var(--color-slate)]">
              {claim.source_snapshot.title}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
