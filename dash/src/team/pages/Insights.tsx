import { useQuery } from '@tanstack/react-query'

import { cn, fmtNum, usd } from '@/lib/utils'
import { getCoaching, getInsights, type CoachingRow, type EvidenceTable, type Filters, type Insight, type InsightKind } from '../lib/api'
import { Empty, ErrorNote, Loading, Panel, TablePanel } from '../ui'

const FLAG_LABELS: Record<string, string> = {
  'low-cache-read': 'low cache use',
  'premium-on-simple': 'premium on simple',
  'spend-spike': 'spend spike',
  'low-one-shot': 'retries on edits',
  'weak-task-type': 'weak task type',
  'no-plan-mode': 'no plan mode',
  'tool-errors': 'tool errors',
  'frequent-interrupts': 'interrupts',
  'frequent-corrections': 'corrections',
  'slow-first-edit': 'slow first edit',
  'file-churn': 'file rework',
}

const GROUPS: Array<{ kind: InsightKind; title: string; hint: string }> = [
  { kind: 'training', title: 'Coaching opportunities', hint: 'How people work with the assistant, and what to try.' },
  { kind: 'cost', title: 'Spend to watch', hint: 'Cost patterns worth a look.' },
  { kind: 'setup', title: 'Setup and missing data', hint: 'Configuration problems and people missing from the insights above.' },
]

const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`)
const pct1 = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`)
const mins = (ms: number | null) => (ms === null ? '-' : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`)

function PersonLink({ id, name }: { id?: string; name: string }) {
  if (!id) return <>{name}</>
  return (
    <a className="text-primary hover:underline" href={`#/people/${encodeURIComponent(id)}`}>
      {name}
    </a>
  )
}

function Evidence({ table }: { table: EvidenceTable }) {
  if (!table.rows.length) return null
  return (
    <div className="mt-2 overflow-x-auto">
      <div className="mb-1 text-[11px] font-medium text-tertiary-foreground">{table.title}</div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-tertiary-foreground">
            {table.columns.map((c, k) => (
              <th key={k} className={cn('border-b border-border py-1 pr-4 font-normal', k > 0 && 'text-right')}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, k) => (
                <td key={k} className={cn('border-b border-border/50 py-1 pr-4', k > 0 && 'text-right tabular-nums')}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InsightCard({ insight: i }: { insight: Insight }) {
  return (
    <div
      className={cn(
        'rounded-md border px-3.5 py-2.5',
        i.severity === 'warn' ? 'border-amber-500/60 bg-amber-500/10' : 'border-border bg-interactive-secondary',
      )}
    >
      <div className="text-sm font-medium">
        <span className="mr-2 text-[10px] uppercase tracking-wider text-tertiary-foreground">{i.severity}</span>
        {i.person ? (
          <>
            <PersonLink id={i.person_id} name={i.person} />
            <span className="text-tertiary-foreground"> - </span>
          </>
        ) : null}
        {i.title}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{i.detail}</div>
      {i.action ? (
        <div className="mt-1.5 text-xs">
          <span className="font-medium">Try: </span>
          {i.action}
        </div>
      ) : null}
      {(i.evidence ?? []).map((t, k) => (
        <Evidence key={k} table={t} />
      ))}
    </div>
  )
}

function CoachingTable({ rows, medians, enabled }: { rows: CoachingRow[]; medians: ReturnType<typeof emptyMedians>; enabled: boolean }) {
  const columns = [
    { key: 'person', label: 'Person' },
    { key: 'spend', label: 'Spend', num: true },
    { key: 'flags', label: 'Flags' },
    { key: 'oneshot', label: 'One-shot', num: true },
    { key: 'retries', label: 'Retries / edit', num: true },
    { key: 'plan', label: 'Plan mode', num: true },
    { key: 'interrupted', label: 'Interrupted', num: true },
    { key: 'premium', label: 'Premium on simple', num: true },
    { key: 'cache', label: 'Cache reads', num: true },
    ...(enabled
      ? [
          { key: 'corrections', label: 'Corrections', num: true },
          { key: 'firstEdit', label: 'First edit', num: true },
          { key: 'rework', label: 'Rework files', num: true },
        ]
      : []),
  ]
  const team = {
    person: <span className="text-tertiary-foreground">Team median</span>,
    spend: '',
    flags: '',
    oneshot: pct(medians.one_shot_rate),
    retries: medians.retries_per_edit === null ? '-' : medians.retries_per_edit.toFixed(2),
    plan: pct1(medians.plan_share),
    interrupted: pct1(medians.interrupted_rate),
    premium: '',
    cache: pct(medians.cache_ratio),
    corrections: '',
    firstEdit: '',
    rework: '',
  }
  const table = rows.map((r) => ({
    person: <PersonLink id={r.person_id} name={r.name} />,
    spend: usd(r.cost),
    flags: r.flags.length ? (
      <span className="flex flex-wrap gap-1">
        {r.flags.map((f) => (
          <span key={f} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px]">
            {FLAG_LABELS[f] ?? f}
          </span>
        ))}
      </span>
    ) : (
      <span className="text-tertiary-foreground">-</span>
    ),
    oneshot: pct(r.one_shot_rate),
    retries: r.retries_per_edit === null ? '-' : r.retries_per_edit.toFixed(2),
    plan: pct1(r.plan_share),
    interrupted: pct1(r.interrupted_rate),
    premium: pct(r.premium_simple_share),
    cache: pct(r.cache_ratio),
    corrections: pct(r.corrections_rate),
    firstEdit: mins(r.median_time_to_first_edit_ms),
    rework: r.reworked_files === null ? '-' : fmtNum(r.reworked_files),
  }))
  return (
    <TablePanel
      title="Who might need coaching"
      filename="team-coaching.csv"
      columns={columns}
      rows={[team, ...table]}
      csv={rows.map((r) => [
        r.name, r.team, r.cost, r.flags.join(' '), r.one_shot_rate, r.retries_per_edit, r.plan_share, r.interrupted_rate,
        r.premium_simple_share, r.cache_ratio, r.corrections_rate, r.median_time_to_first_edit_ms, r.reworked_files,
      ])}
    />
  )
}

const emptyMedians = () => ({
  one_shot_rate: null as number | null,
  retries_per_edit: null as number | null,
  plan_share: null as number | null,
  interrupted_rate: null as number | null,
  cache_ratio: null as number | null,
  tool_error_rate: null as number | null,
})

export function Insights({ filters }: { filters: Filters }) {
  const q = useQuery({ queryKey: ['insights', filters], queryFn: () => getInsights(filters) })
  const c = useQuery({ queryKey: ['coaching', filters], queryFn: () => getCoaching(filters) })
  if (q.isLoading || c.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const { insights, findings } = q.data!
  const coaching = c.data
  const rows = coaching?.rows ?? []
  if (!insights.length && !findings.length && !rows.length) return <Empty>Nothing notable for this period.</Empty>
  const total = findings.reduce((s, f) => s + (f.estimated_savings_usd || 0), 0)
  return (
    <div className="flex flex-col gap-4">
      {rows.length ? <CoachingTable rows={rows} medians={coaching!.medians} enabled={coaching!.coaching_enabled} /> : null}
      {GROUPS.map((g) => {
        const list = insights.filter((i) => i.kind === g.kind)
        if (!list.length) return null
        return (
          <Panel key={g.kind} title={g.title}>
            <div className="mb-2.5 text-xs text-tertiary-foreground">{g.hint}</div>
            <div className="flex flex-col gap-2.5">
              {list.map((i, k) => (
                <InsightCard key={`${i.id}-${i.person_id ?? ''}-${k}`} insight={i} />
              ))}
            </div>
          </Panel>
        )
      })}
      {findings.length ? (
        <TablePanel
          title={`Recurring optimize findings (est. savings ${usd(total)})`}
          filename="team-findings.csv"
          columns={[
            { key: 'title', label: 'Finding' },
            { key: 'people', label: 'People', num: true },
            { key: 'names', label: 'Who' },
            { key: 'savings', label: 'Est. savings', num: true },
          ]}
          rows={findings.map((f) => ({ title: f.title, people: fmtNum(f.people), names: (f.names ?? []).join(', '), savings: usd(f.estimated_savings_usd) }))}
          csv={findings.map((f) => [f.title, f.people, (f.names ?? []).join('; '), f.estimated_savings_usd])}
        />
      ) : null}
    </div>
  )
}
