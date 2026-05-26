import { ArrowUpRight } from 'lucide-react'
import type { ComplianceEntry, ComplianceResult } from '../lib/types'

// Rule-key → human label. Mirrors RULE_LABELS in lib/rule-catalog.ts but
// the compliance engine emits aggregated keys (e.g. 'setback.*.min' for the
// uniform-conservative setback check) that don't appear in the claims
// table, so we cover them here without polluting the claims catalog.
const COMPLIANCE_LABELS: Record<string, string> = {
  'setback.*.min': 'Setback (uniform)',
  'lot.coverage.max': 'Lot coverage',
  'height.max': 'Height',
  'height.max.principal': 'Height',
  'lot.area.min': 'Min lot area',
}

function ruleLabel(key: string): string {
  return COMPLIANCE_LABELS[key] ?? key
}

function formatMargin(margin: number | undefined, suffix: string): string {
  if (margin === undefined) return ''
  const sign = margin > 0 ? '+' : ''
  return `margin ${sign}${margin}${suffix}`
}

// Status marker: restrained, single mono glyph in the appropriate hue.
// pass = accent (blue); fail = ink (heavy but not red); not_evaluated = mist.
// The marker is colorblind-safe because the glyph itself is distinct
// (✓ / ✕ / —), and the status label is also spelled out.
type StatusMarkerProps = { result: ComplianceEntry['result'] }

function StatusMarker({ result }: StatusMarkerProps) {
  if (result === 'pass') {
    return (
      <span
        aria-label="passes"
        className="font-mono text-sm leading-none text-[var(--color-accent)]"
      >
        ✓
      </span>
    )
  }
  if (result === 'fail') {
    return (
      <span
        aria-label="exceeds limit"
        className="font-mono text-sm font-semibold leading-none text-[var(--color-ink)]"
      >
        ✕
      </span>
    )
  }
  return (
    <span
      aria-label="not evaluated"
      className="font-mono text-sm leading-none text-[var(--color-mist)]"
    >
      —
    </span>
  )
}

function statusWord(result: ComplianceEntry['result']): string {
  if (result === 'pass') return 'PASS'
  if (result === 'fail') return 'FAIL'
  return 'N/E'
}

function statusWordClass(result: ComplianceEntry['result']): string {
  if (result === 'pass') return 'text-[var(--color-accent)]'
  if (result === 'fail') return 'text-[var(--color-ink)]'
  return 'text-[var(--color-mist)]'
}

// Per-kind value formatting. Kept here (not in rule-catalog) because these
// strings are specific to the compliance engine's per-check fields — they
// describe what the check measured, not what the claim asserts.
function entrySummary(entry: ComplianceEntry): string | null {
  if (entry.result === 'not_evaluated') return null

  if (entry.check_kind === 'spatial_inset') {
    if (entry.value_used_ft === undefined) return null
    const role = entry.driving_role ?? '—'
    return `${entry.value_used_ft} ft (most-restrictive, ${role})`
  }

  if (entry.check_kind === 'area_ratio' && entry.actual_pct !== undefined) {
    const m = formatMargin(entry.margin_pct, ' pct')
    return `${entry.actual_pct}% of ${entry.limit_pct}% (${m})`
  }

  if (entry.check_kind === 'scalar_max' && entry.actual_ft !== undefined) {
    const m = formatMargin(entry.margin_ft, ' ft')
    return `${entry.actual_ft} / ${entry.limit_ft} ft (${m})`
  }

  return null
}

type ResultRowProps = { entry: ComplianceEntry }

function ResultRow({ entry }: ResultRowProps) {
  const summary = entrySummary(entry)
  const sectionRef = entry.citation?.section_ref ?? null
  const sectionUrl = entry.citation?.section_url ?? null

  return (
    <div className="grid grid-cols-[1.25rem_1fr] items-start gap-x-3 py-3">
      <div className="pt-[3px]">
        <StatusMarker result={entry.result} />
      </div>

      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-sans text-sm text-[var(--color-ink)]">
            {ruleLabel(entry.rule_key)}
          </p>
          <p
            className={`shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] ${statusWordClass(
              entry.result,
            )}`}
          >
            {statusWord(entry.result)}
          </p>
        </div>

        {summary ? (
          <p
            className="mt-0.5 font-serif text-base leading-snug text-[var(--color-ink)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {summary}
          </p>
        ) : null}

        {entry.result === 'not_evaluated' && entry.reason ? (
          <p className="mt-0.5 font-sans text-xs italic text-[var(--color-mist)]">
            {entry.reason}
          </p>
        ) : null}

        {entry.note ? (
          <p className="mt-1 font-sans text-xs italic text-[var(--color-slate)]">
            {entry.note}
          </p>
        ) : null}

        {sectionRef ? (
          <p className="mt-1.5 font-mono text-[11px]">
            {sectionUrl ? (
              <a
                href={sectionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--color-slate)] hover:text-[var(--color-accent)] hover:underline"
              >
                {sectionRef}
                <ArrowUpRight
                  className="ml-0.5 inline-block align-text-top"
                  size={10}
                  aria-hidden
                />
              </a>
            ) : (
              <span className="text-[var(--color-slate)]">{sectionRef}</span>
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}

type ComplianceResultsProps = {
  result: ComplianceResult
}

export function ComplianceResults({ result }: ComplianceResultsProps) {
  const { results } = result

  return (
    <section>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        COMPLIANCE
      </p>

      {results.length === 0 ? (
        <p className="font-sans text-xs italic text-[var(--color-mist)]">
          No constraints evaluated for this constraint set.
        </p>
      ) : (
        <div className="divide-y divide-[var(--color-fog)]">
          {results.map((entry, idx) => (
            <ResultRow
              key={`${entry.rule_key}-${entry.check_kind}-${idx}`}
              entry={entry}
            />
          ))}
        </div>
      )}
    </section>
  )
}
