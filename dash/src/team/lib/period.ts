export type PeriodKey = '7d' | '30d' | '90d' | 'this-month' | 'last-month' | 'custom'
export type Range = { from: string; to: string }

export const PERIOD_OPTIONS: Array<{ key: PeriodKey; label: string }> = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'custom', label: 'Custom' },
]

const DAY_MS = 86_400_000

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function parseDay(s: string): Date {
  return new Date(s + 'T00:00:00Z')
}

export function addDays(day: string, n: number): string {
  return isoDay(new Date(parseDay(day).getTime() + n * DAY_MS))
}

export function isValidDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDay(parseDay(s)) === s
}

/** Inclusive range for a period key; all days are UTC (matches the server). */
export function computeRange(key: PeriodKey, now: Date = new Date(), custom?: Range): Range {
  const today = isoDay(now)
  switch (key) {
    case '7d':
      return { from: addDays(today, -6), to: today }
    case '30d':
      return { from: addDays(today, -29), to: today }
    case '90d':
      return { from: addDays(today, -89), to: today }
    case 'this-month':
      return { from: today.slice(0, 8) + '01', to: today }
    case 'last-month': {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
      return { from: isoDay(first), to: isoDay(last) }
    }
    case 'custom': {
      if (custom && isValidDay(custom.from) && isValidDay(custom.to)) {
        return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from }
      }
      return { from: addDays(today, -29), to: today }
    }
  }
}

export function dayCount(r: Range): number {
  return Math.round((parseDay(r.to).getTime() - parseDay(r.from).getTime()) / DAY_MS) + 1
}

/** The period of equal length immediately before `r`. */
export function previousRange(r: Range): Range {
  const n = dayCount(r)
  return { from: addDays(r.from, -n), to: addDays(r.from, -1) }
}

/** Percent change cur vs prev; null when there is no baseline. */
export function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null
  return ((cur - prev) / prev) * 100
}
