import { ArrowUpRight } from 'lucide-react'
import type { Classification } from '../lib/types'

type ZoningCoverageProps = {
  classification: Classification
}

export function ZoningCoverage({ classification }: ZoningCoverageProps) {
  const { overlay_codes, unclassified_codes } = classification

  if (overlay_codes.length === 0 && unclassified_codes.length === 0) {
    return null
  }

  return (
    <section>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        ZONING COVERAGE
      </p>

      {overlay_codes.map((overlay) => (
        <div key={overlay.code} className="mb-4 last:mb-0">
          <p className="font-mono text-xs text-[var(--color-ink)]">
            {overlay.code}
            {overlay.label ? ` · ${overlay.label}` : null}
          </p>
          <p className="mt-0.5 text-sm italic text-[var(--color-mist)]">
            Overlay applies — provisions not yet modeled.
          </p>
          {overlay.code_section && overlay.source_url ? (
            <p className="mt-1 font-mono text-xs text-[var(--color-slate)]">
              <a
                href={overlay.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-slate)] hover:text-[var(--color-accent)] hover:underline"
              >
                {overlay.code_section}
                <ArrowUpRight
                  className="ml-0.5 inline-block align-text-top"
                  size={10}
                  aria-hidden
                />
              </a>
            </p>
          ) : null}
        </div>
      ))}

      {unclassified_codes.length > 0 ? (
        <div className={overlay_codes.length > 0 ? 'mt-4' : undefined}>
          <p className="text-sm italic text-[var(--color-mist)]">
            Not yet classified: {unclassified_codes.join(', ')}
          </p>
          <p className="mt-1 text-xs italic text-[var(--color-mist)]">
            Tokens present in the assessor zoning string with no entry in this
            jurisdiction&apos;s zone registry.
          </p>
        </div>
      ) : null}
    </section>
  )
}
