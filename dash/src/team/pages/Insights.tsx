import { useQuery } from '@tanstack/react-query'

import { cn, fmtNum, usd } from '@/lib/utils'
import { getInsights, type Filters } from '../lib/api'
import { Empty, ErrorNote, Loading, Panel, TablePanel } from '../ui'

export function Insights({ filters }: { filters: Filters }) {
  const q = useQuery({ queryKey: ['insights', filters], queryFn: () => getInsights(filters) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const { insights, findings } = q.data!
  if (!insights.length && !findings.length) return <Empty>Nothing notable for this period.</Empty>
  const total = findings.reduce((s, f) => s + (f.estimated_savings_usd || 0), 0)
  return (
    <div className="flex flex-col gap-4">
      {insights.length ? (
        <Panel title="Callouts">
          <div className="flex flex-col gap-2.5">
            {insights.map((i) => (
              <div
                key={i.id}
                className={cn(
                  'rounded-md border px-3.5 py-2.5',
                  i.severity === 'warn' ? 'border-amber-500/60 bg-amber-500/10' : 'border-border bg-interactive-secondary',
                )}
              >
                <div className="text-sm font-medium">
                  <span className="mr-2 text-[10px] uppercase tracking-wider text-tertiary-foreground">{i.severity}</span>
                  {i.title}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {i.detail}
                  {i.person ? <span className="text-tertiary-foreground"> - {i.person}</span> : null}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}
      {findings.length ? (
        <TablePanel
          title={`Recurring optimize findings (est. savings ${usd(total)})`}
          filename="team-findings.csv"
          columns={[
            { key: 'title', label: 'Finding' },
            { key: 'people', label: 'People', num: true },
            { key: 'savings', label: 'Est. savings', num: true },
          ]}
          rows={findings.map((f) => ({ title: f.title, people: fmtNum(f.people), savings: usd(f.estimated_savings_usd) }))}
          csv={findings.map((f) => [f.title, f.people, f.estimated_savings_usd])}
        />
      ) : null}
    </div>
  )
}
