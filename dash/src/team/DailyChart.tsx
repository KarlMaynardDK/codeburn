import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

import type { DailyRow } from './lib/api'
import { compactUsd, fmtTokens, usd } from '@/lib/utils'

export type Unit = 'cost' | 'tokens'

export function DailyChart({ daily, unit }: { daily: DailyRow[]; unit: Unit }) {
  const data = daily.map((d) => ({
    day: d.day,
    value: unit === 'cost' ? d.cost : d.input + d.output + d.cache_read + d.cache_write,
  }))
  if (!data.length) return <div className="py-12 text-center text-sm text-tertiary-foreground">No data.</div>
  const fmt = unit === 'cost' ? usd : fmtTokens
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid-stroke)" />
          <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 11 }} minTickGap={24} />
          <YAxis tickFormatter={(v: number) => (unit === 'cost' ? compactUsd(v) : fmtTokens(v))} tick={{ fontSize: 11 }} width={52} />
          <Tooltip
            cursor={{ fill: 'var(--chart-hover-cursor)' }}
            formatter={(v) => [fmt(Number(v)), unit === 'cost' ? 'Cost' : 'Tokens']}
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
          />
          <Bar dataKey="value" fill="var(--chart-1)" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Tiny inline sparkline for per-person daily-cost trends. */
export function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-tertiary-foreground">-</span>
  const max = Math.max(...values, 0.0001)
  const w = 80
  const h = 20
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`)
  return (
    <svg width={w} height={h} className="inline-block align-middle" aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke="var(--chart-1)" strokeWidth="1.5" />
    </svg>
  )
}
