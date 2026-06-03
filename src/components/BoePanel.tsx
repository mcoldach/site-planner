import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

const SQ_FT_PER_ACRE = 43560

type BoePanelProps = {
  gfa: number // gross floor area in SF
  footprintSf: number // total building footprint SF
  landSf: number // parcel land area in SF (computed by caller)
}

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return currencyFmt.format(value)
}

function formatPct(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

type AssumptionFieldProps = {
  label: string
  value: number
  onChange: (next: number) => void
  step: number
  suffix?: string
}

// Spreadsheet-cell style row: left-aligned mono label, right-aligned narrow
// number input. Mirrors the FootprintRow input treatment (hairline, white
// bg, tabular-nums) so the assumptions grid reads like the rest of the panel.
function AssumptionField({
  label,
  value,
  onChange,
  step,
  suffix,
}: AssumptionFieldProps) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        {label}
      </span>
      <span className="flex shrink-0 items-baseline gap-1">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') {
              onChange(0)
              return
            }
            const parsed = Number.parseFloat(raw)
            onChange(Number.isFinite(parsed) ? parsed : 0)
          }}
          className="hairline w-20 rounded-sm bg-white px-2 py-1 text-right font-sans text-sm text-[var(--color-ink)]"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        />
        {suffix ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
            {suffix}
          </span>
        ) : null}
      </span>
    </label>
  )
}

type SupportingRowProps = {
  label: string
  value: string
}

function SupportingRow({ label, value }: SupportingRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        {label}
      </span>
      <span
        className="font-sans text-sm text-[var(--color-ink)]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </span>
    </div>
  )
}

// First-pass underwrite for one saved scheme. The headline is residual land
// value — the most a developer could pay for the dirt and still clear their
// target yield-on-cost. Every number here is derived from user-editable
// assumptions; nothing is cited, so the panel is feasibility-grade by design.
export function BoePanel({ gfa, footprintSf, landSf }: BoePanelProps) {
  const [assumptionsOpen, setAssumptionsOpen] = useState(true)

  const [hardCostPerSf, setHardCostPerSf] = useState(175)
  const [softCostPct, setSoftCostPct] = useState(30)
  const [rentPerSfYr, setRentPerSfYr] = useState(18.0)
  const [vacancyPct, setVacancyPct] = useState(6)
  const [opexPct, setOpexPct] = useState(35)
  const [capRate, setCapRate] = useState(5.5)
  const [targetYoc, setTargetYoc] = useState(7.0)

  const m = useMemo(() => {
    // Revenue
    const grossPotentialRevenue = gfa * rentPerSfYr
    const vacancyLoss = grossPotentialRevenue * (vacancyPct / 100)
    const effectiveGrossIncome = grossPotentialRevenue - vacancyLoss
    const operatingExpenses = effectiveGrossIncome * (opexPct / 100)
    const noi = effectiveGrossIncome - operatingExpenses

    // Cost (ex-land)
    const hardCosts = gfa * hardCostPerSf
    const softCosts = hardCosts * (softCostPct / 100)
    const totalDevCostExLand = hardCosts + softCosts

    // Valuation
    const stabilizedValue = noi / (capRate / 100)

    // Residual land value — THE CORE OUTPUT
    const maxTotalCost = noi / (targetYoc / 100)
    const residualLandValue = maxTotalCost - totalDevCostExLand

    // Derived
    const residualPerSf = residualLandValue / landSf
    const residualPerAcre = residualLandValue / (landSf / SQ_FT_PER_ACRE)
    const devMargin = stabilizedValue - maxTotalCost
    const profitMargin = (devMargin / maxTotalCost) * 100

    // Sanity check: realized YOC should equal target.
    const yoc = (noi / maxTotalCost) * 100

    return {
      noi,
      totalDevCostExLand,
      stabilizedValue,
      maxTotalCost,
      residualLandValue,
      residualPerSf,
      residualPerAcre,
      devMargin,
      profitMargin,
      yoc,
    }
  }, [
    gfa,
    landSf,
    hardCostPerSf,
    softCostPct,
    rentPerSfYr,
    vacancyPct,
    opexPct,
    capRate,
    targetYoc,
  ])

  const landAcres = landSf / SQ_FT_PER_ACRE
  const pencils = m.residualLandValue >= 0

  return (
    <section>
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
        BACK OF ENVELOPE
      </p>

      <p
        className="font-mono text-[11px] text-[var(--color-slate)]"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        GFA: {Math.round(gfa).toLocaleString('en-US')} SF · Land:{' '}
        {landAcres.toFixed(2)} ac · Footprint:{' '}
        {Math.round(footprintSf).toLocaleString('en-US')} SF
      </p>

      <button
        type="button"
        onClick={() => setAssumptionsOpen((prev) => !prev)}
        aria-expanded={assumptionsOpen}
        className="mt-4 flex w-full items-center gap-1.5 text-left"
      >
        {assumptionsOpen ? (
          <ChevronDown
            className="size-3.5 text-[var(--color-slate)]"
            strokeWidth={2}
            aria-hidden
          />
        ) : (
          <ChevronRight
            className="size-3.5 text-[var(--color-slate)]"
            strokeWidth={2}
            aria-hidden
          />
        )}
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          Assumptions
        </span>
      </button>

      {assumptionsOpen ? (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
          <AssumptionField
            label="Hard $/SF"
            value={hardCostPerSf}
            onChange={setHardCostPerSf}
            step={5}
          />
          <AssumptionField
            label="Soft %"
            value={softCostPct}
            onChange={setSoftCostPct}
            step={1}
            suffix="%"
          />
          <AssumptionField
            label="Rent $/SF/yr"
            value={rentPerSfYr}
            onChange={setRentPerSfYr}
            step={0.25}
          />
          <AssumptionField
            label="Vacancy"
            value={vacancyPct}
            onChange={setVacancyPct}
            step={0.5}
            suffix="%"
          />
          <AssumptionField
            label="OpEx % EGI"
            value={opexPct}
            onChange={setOpexPct}
            step={1}
            suffix="%"
          />
          <AssumptionField
            label="Cap Rate"
            value={capRate}
            onChange={setCapRate}
            step={0.25}
            suffix="%"
          />
          <AssumptionField
            label="Target YOC"
            value={targetYoc}
            onChange={setTargetYoc}
            step={0.25}
            suffix="%"
          />
        </div>
      ) : null}

      <div className="mt-5">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--color-slate)]">
          Residual Land Value
        </p>
        <p
          className={`mt-1 font-serif text-3xl leading-none ${
            pencils ? 'text-[var(--color-ink)]' : 'text-[#a83232]'
          }`}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {formatCurrency(m.residualLandValue)}
        </p>
        {pencils ? (
          <p
            className="mt-1.5 font-sans text-xs text-[var(--color-slate)]"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            ({formatCurrency(m.residualPerSf)} / SF land ·{' '}
            {formatCurrency(m.residualPerAcre)} / acre)
          </p>
        ) : (
          <p className="mt-1.5 font-sans text-xs text-[#a83232]">
            Does not pencil at these assumptions
          </p>
        )}
      </div>

      <div className="mt-5 space-y-2">
        <SupportingRow
          label="NOI at Stabilization"
          value={formatCurrency(m.noi)}
        />
        <SupportingRow
          label="Stabilized Value"
          value={formatCurrency(m.stabilizedValue)}
        />
        <SupportingRow
          label="Dev Cost (ex-land)"
          value={formatCurrency(m.totalDevCostExLand)}
        />
        <SupportingRow label="Dev Margin" value={formatCurrency(m.devMargin)} />
        <SupportingRow label="YOC" value={formatPct(m.yoc)} />
      </div>
    </section>
  )
}
