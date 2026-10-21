import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { cn, fmtTokens, label, usd } from '@/lib/utils'
import { getModels, type Filters } from '../lib/api'
import { isPremiumModel, isPremiumOnSimple } from '../lib/models'
import { Empty, ErrorNote, Loading, Panel, TablePanel, CsvButton } from '../ui'

export function Models({ filters }: { filters: Filters }) {
  const q = useQuery({ queryKey: ['models', filters], queryFn: () => getModels(filters) })
  const data = q.data
  const grid = useMemo(() => {
    const m = data?.matrix ?? []
    const models = [...new Set(m.map((c) => c.model))]
    const cats = [...new Set(m.map((c) => c.category))]
    const cost = new Map(m.map((c) => [c.model + '\u0000' + c.category, c]))
    const modelTotal = (x: string) => m.filter((c) => c.model === x).reduce((s, c) => s + c.cost, 0)
    const catTotal = (x: string) => m.filter((c) => c.category === x).reduce((s, c) => s + c.cost, 0)
    models.sort((a, b) => modelTotal(b) - modelTotal(a))
    cats.sort((a, b) => catTotal(b) - catTotal(a))
    return { models, cats, cost, max: Math.max(...m.map((c) => c.cost), 0.0001) }
  }, [data])

  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const d = data!
  if (!d.matrix.length && !d.by_model.length) return <Empty />

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Model by task category (cost)"
        actions={
          <CsvButton
            filename="team-model-category.csv"
            headers={['Model', 'Category', 'Cost USD', 'Tokens', 'Calls', 'People', 'Premium on simple']}
            rows={d.matrix.map((c) => [c.model, c.category, c.cost, c.tokens, c.calls, c.people, isPremiumOnSimple(c.model, c.category) ? 'yes' : 'no'])}
          />
        }
      >
        <p className="mb-3 text-xs text-tertiary-foreground">
          Cells outlined in red are premium models spent on simple categories (conversation, exploration, general).
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="pb-2 text-left text-[11px] font-medium uppercase tracking-wider text-tertiary-foreground">Model</th>
                {grid.cats.map((c) => (
                  <th key={c} className="pb-2 text-right text-[11px] font-medium uppercase tracking-wider text-tertiary-foreground">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.models.map((m) => (
                <tr key={m} className="border-t border-border">
                  <td className={cn('py-2 pr-3', isPremiumModel(m) && 'font-medium')} title={m}>{label(m)}</td>
                  {grid.cats.map((c) => {
                    const cell = grid.cost.get(m + '\u0000' + c)
                    const flag = cell ? isPremiumOnSimple(m, c) : false
                    return (
                      <td key={c} className="p-1 text-right tabular-nums">
                        {cell ? (
                          <div
                            className={cn('rounded px-2 py-1', flag && 'ring-1 ring-red-500')}
                            style={{ background: `color-mix(in srgb, var(--chart-${flag ? 5 : 1}) ${Math.round((cell.cost / grid.max) * 55)}%, transparent)` }}
                            title={`${cell.calls} calls, ${fmtTokens(cell.tokens)} tokens, ${cell.people} people`}
                          >
                            {usd(cell.cost)}
                          </div>
                        ) : (
                          <span className="text-tertiary-foreground">-</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <TablePanel
        title="Models"
        filename="team-models.csv"
        columns={[
          { key: 'model', label: 'Model' },
          { key: 'cost', label: 'Cost', num: true },
          { key: 'tokens', label: 'Tokens', num: true },
          { key: 'calls', label: 'Calls', num: true },
        ]}
        rows={[...d.by_model].sort((a, b) => b.cost - a.cost).map((m) => ({ model: label(m.name), cost: usd(m.cost), tokens: fmtTokens(m.tokens), calls: m.calls ?? '-' }))}
        csv={d.by_model.map((m) => [m.name, m.cost, m.tokens, m.calls])}
      />
    </div>
  )
}
