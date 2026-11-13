/** Number and date wording for the Usage view. */

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

const SMALL_CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 })

/**
 * Dollars to the cent. A real amount under a cent keeps two significant digits
 * (`$0.0012`), because `$0.00` beside a 100% share reads as free, and so would an
 * axis of four `$0.00` ticks.
 */
export const formatUsd = (value: number) =>
  value !== 0 && Math.abs(value) < 0.01 ? SMALL_CURRENCY.format(value) : CURRENCY.format(value)

export const formatCount = (value: number) => INTEGER.format(Math.round(value))

const trim = (value: number) => {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return value.toFixed(digits).replace(/\.0+$/, '')
}

/** Three significant figures with a unit, so token columns line up: `19.9B`, `76.7M`, `804K`. */
export function formatTokens(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${trim(value / 1e12)}T`
  if (abs >= 1e9) return `${trim(value / 1e9)}B`
  if (abs >= 1e6) return `${trim(value / 1e6)}M`
  if (abs >= 1e3) return `${trim(value / 1e3)}K`
  return INTEGER.format(Math.round(value))
}

/** A share as `12.3%`; a real share below the last digit reads `<0.1%`, never `0.0%`. */
export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100
  const smallest = 10 ** -digits
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`
  return `${percent.toFixed(digits)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-08-07` → `Aug 7`. */
export function formatDayShort(day: string): string {
  const [, month, date] = day.split('-').map(Number)
  if (month === undefined || date === undefined || MONTHS[month - 1] === undefined) return day
  return `${MONTHS[month - 1]!} ${String(date)}`
}

/** Every day from `since` to `until`, inclusive, as `YYYY-MM-DD`. */
export function enumerateDays(since: string, until: string): string[] {
  const start = Date.parse(`${since}T00:00:00Z`)
  const end = Date.parse(`${until}T00:00:00Z`)
  const days: string[] = []
  if (Number.isNaN(start) || Number.isNaN(end)) return days
  for (let cursor = start; cursor <= end; cursor += 86_400_000) days.push(new Date(cursor).toISOString().slice(0, 10))
  return days
}
