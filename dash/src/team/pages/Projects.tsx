import { useQuery } from '@tanstack/react-query'

import { fmtNum, fmtTokens, usd } from '@/lib/utils'
import { getProjects, type Filters } from '../lib/api'
import { Empty, ErrorNote, Loading, TablePanel } from '../ui'

export function Projects({ filters }: { filters: Filters }) {
  const q = useQuery({ queryKey: ['projects', filters], queryFn: () => getProjects(filters) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const rows = [...q.data!].sort((a, b) => b.cost - a.cost)
  if (!rows.length) return <Empty />
  return (
    <TablePanel
      title="Projects"
      filename="team-projects.csv"
      columns={[
        { key: 'project', label: 'Project' },
        { key: 'cost', label: 'Cost', num: true },
        { key: 'tokens', label: 'Tokens', num: true },
        { key: 'calls', label: 'Calls', num: true },
        { key: 'people', label: 'People', num: true },
        { key: 'top', label: 'Top person' },
      ]}
      rows={rows.map((p) => ({
        project: p.project,
        cost: usd(p.cost),
        tokens: fmtTokens(p.tokens),
        calls: fmtNum(p.calls),
        people: fmtNum(p.people),
        top: p.top_person ?? '-',
      }))}
      csv={rows.map((p) => [p.project, p.cost, p.tokens, p.calls, p.people, p.top_person])}
    />
  )
}
