import { useQuery } from '@tanstack/react-query'

import { MetricCard } from '@/components/MetricCard'
import { BarList } from '@/components/BarList'
import { fmtNum, fmtTokens, label, usd } from '@/lib/utils'
import { getPeople, getPerson, type Breakdown, type Filters, type PersonRow } from '../lib/api'
import { DailyChart, Spark } from '../DailyChart'
import { Button, CsvButton, Empty, ErrorNote, Loading, Panel, TablePanel } from '../ui'

const tok = (p: PersonRow) => p.input + p.output + p.cache_read + p.cache_write
const pct = (r: number | undefined) => (r == null ? '-' : (r * 100).toFixed(0) + '%')
const when = (s?: string | null) => (s ? s.slice(0, 16).replace('T', ' ') : '-')

export function People({ filters, onOpen }: { filters: Filters; onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['people', filters], queryFn: () => getPeople(filters) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const people = [...q.data!].sort((a, b) => b.cost - a.cost)
  if (!people.length) return <Empty />
  return (
    <TablePanel
      title="People"
      filename="team-people.csv"
      columns={[
        { key: 'name', label: 'Person' },
        { key: 'team', label: 'Team' },
        { key: 'cost', label: 'Cost', num: true },
        { key: 'tokens', label: 'Tokens', num: true },
        { key: 'calls', label: 'Calls', num: true },
        { key: 'cache', label: 'Cache read', num: true },
        { key: 'oneShot', label: 'One-shot', num: true },
        { key: 'lines', label: 'Lines +/-', num: true },
        { key: 'model', label: 'Top model' },
        { key: 'trend', label: 'Trend' },
        { key: 'seen', label: 'Last seen' },
        { key: 'through', label: 'Data through' },
      ]}
      rows={people.map((p) => ({
        name: (
          <button type="button" className="text-primary hover:underline" onClick={() => onOpen(p.id)}>
            {p.name}
          </button>
        ),
        team: p.team ?? '-',
        cost: usd(p.cost),
        tokens: fmtTokens(tok(p)),
        calls: fmtNum(p.calls),
        cache: pct(p.cache_read_ratio),
        oneShot: pct(p.one_shot_rate ?? undefined),
        lines: p.lines_added || p.lines_removed ? `+${fmtNum(p.lines_added)} / -${fmtNum(p.lines_removed)}` : '-',
        model: p.top_model ? label(p.top_model) : '-',
        trend: <Spark values={p.trend} />,
        seen: when(p.last_seen),
        through: p.data_through ?? '-',
      }))}
      csv={people.map((p) => [p.name, p.email, p.team, p.cost, p.input, p.output, p.cache_read, p.cache_write, p.calls, p.cache_read_ratio, p.one_shot_rate, p.lines_added, p.lines_removed, p.top_model, p.last_seen, p.data_through])}
    />
  )
}

function Split({ title, items, useLabel }: { title: string; items: Breakdown[]; useLabel?: boolean }) {
  const sorted = [...items].sort((a, b) => b.cost - a.cost).slice(0, 10)
  return (
    <Panel
      title={title}
      actions={<CsvButton filename={`person-${title.toLowerCase().replace(/\W+/g, '-')}.csv`} headers={['Name', 'Cost USD', 'Tokens', 'Calls']} rows={items.map((i) => [i.name, i.cost, i.tokens, i.calls])} />}
    >
      <BarList
        items={sorted.map((i) => ({ name: useLabel ? label(i.name) : i.name, value: i.cost, display: usd(i.cost) }))}
        total={sorted.reduce((s, i) => s + i.cost, 0)}
      />
    </Panel>
  )
}

export function PersonDetail({ id, filters, onBack }: { id: string; filters: Filters; onBack?: () => void }) {
  const q = useQuery({ queryKey: ['person', id, filters], queryFn: () => getPerson(id, filters) })
  return (
    <div className="flex flex-col gap-4">
      {onBack ? (
        <div>
          <Button onClick={onBack}>Back to people</Button>
        </div>
      ) : null}
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : <Detail d={q.data!} />}
    </div>
  )
}

function Detail({ d }: { d: Awaited<ReturnType<typeof getPerson>> }) {
  const p = d.person
  return (
    <>
      <h2 className="text-lg font-semibold">
        {p.name} <span className="text-sm font-normal text-tertiary-foreground">{p.team ?? ''} {p.email ?? ''}</span>
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Spend" value={usd(p.cost)} accent />
        <MetricCard label="Tokens" value={fmtTokens(tok(p))} />
        <MetricCard label="Calls" value={fmtNum(p.calls)} />
        <MetricCard label="Cache read" value={pct(p.cache_read_ratio)} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="One-shot edits" value={pct(p.one_shot_rate ?? undefined)} sub={p.edit_turns ? `${fmtNum(p.one_shot_turns)} of ${fmtNum(p.edit_turns)} edit prompts` : undefined} />
        <MetricCard label="Lines changed" value={`+${fmtNum(p.lines_added)} / -${fmtNum(p.lines_removed)}`} />
        <MetricCard label="Tool errors" value={fmtNum(p.tool_errors)} />
        <MetricCard label="Data through" value={p.data_through ?? '-'} sub={p.last_seen ? `last seen ${when(p.last_seen)}` : undefined} />
      </div>
      <Panel title="Usage over time">
        <DailyChart daily={d.daily} unit="cost" />
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Split title="By tool" items={d.by_provider} />
        <Split title="By model" items={d.by_model} useLabel />
        <Split title="By project" items={d.by_project} />
        <Split title="By category" items={d.by_category} />
      </div>
    </>
  )
}
