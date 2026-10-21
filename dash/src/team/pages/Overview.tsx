import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { MetricCard } from '@/components/MetricCard'
import { BarList } from '@/components/BarList'
import { fmtNum, fmtTokens, label, usd } from '@/lib/utils'
import { getOverview, type Breakdown, type Filters } from '../lib/api'
import { pctChange } from '../lib/period'
import { DailyChart, type Unit } from '../DailyChart'
import { CsvButton, Empty, ErrorNote, Loading, Panel, selectCls } from '../ui'

function delta(cur: number, prev: number | undefined): string | undefined {
  if (prev === undefined) return undefined
  const p = pctChange(cur, prev)
  return p === null ? 'no previous data' : `${p >= 0 ? '+' : ''}${p.toFixed(0)}% vs previous`
}

function Split({ title, items, useLabel }: { title: string; items: Breakdown[]; useLabel?: boolean }) {
  const sorted = [...items].sort((a, b) => b.cost - a.cost).slice(0, 10)
  const total = sorted.reduce((s, i) => s + i.cost, 0)
  return (
    <Panel
      title={title}
      actions={<CsvButton filename={`team-${title.toLowerCase().replace(/\W+/g, '-')}.csv`} headers={['Name', 'Cost USD', 'Tokens']} rows={items.map((i) => [i.name, i.cost, i.tokens])} />}
    >
      <BarList items={sorted.map((i) => ({ name: useLabel ? label(i.name) : i.name, value: i.cost, display: usd(i.cost) }))} total={total} />
    </Panel>
  )
}

export function Overview({ filters, compare }: { filters: Filters; compare: boolean }) {
  const [unit, setUnit] = useState<Unit>('cost')
  const q = useQuery({ queryKey: ['overview', filters, compare], queryFn: () => getOverview(filters, compare) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const o = q.data!
  const t = o.totals
  const tokens = t.input + t.output + t.cache_read + t.cache_write
  if (!o.daily.length && t.cost === 0 && tokens === 0) return <Empty />
  const c = o.compare
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Spend" value={usd(t.cost)} sub={delta(t.cost, c?.cost)} accent />
        <MetricCard label="Tokens" value={fmtTokens(tokens)} sub={delta(tokens, c?.tokens)} />
        <MetricCard label="Calls" value={fmtNum(t.calls)} />
        <MetricCard label="Active people" value={fmtNum(t.active_people)} />
      </div>
      {o.mtd ? (
        <div className="grid grid-cols-2 gap-3">
          <MetricCard label="Month to date" value={usd(o.mtd.cost)} sub={`day ${o.mtd.days_elapsed} of ${o.mtd.days_in_month}`} />
          <MetricCard label="Projected month" value={usd(o.mtd.projected_month_cost)} sub="at the current daily pace" />
        </div>
      ) : null}
      <Panel
        title="Usage over time"
        actions={
          <div className="flex items-center gap-2">
            <select className={selectCls} value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
              <option value="cost">Cost</option>
              <option value="tokens">Tokens</option>
            </select>
            <CsvButton
              filename="team-daily.csv"
              headers={['Day', 'Cost USD', 'Input', 'Output', 'Cache read', 'Cache write', 'Calls']}
              rows={o.daily.map((d) => [d.day, d.cost, d.input, d.output, d.cache_read, d.cache_write, d.calls])}
            />
          </div>
        }
      >
        <DailyChart daily={o.daily} unit={unit} />
      </Panel>
      <div className="grid gap-4 lg:grid-cols-3">
        <Split title="By tool" items={o.by_provider} />
        <Split title="By model" items={o.by_model} useLabel />
        <Split title="By team" items={o.by_team} />
      </div>
    </div>
  )
}
