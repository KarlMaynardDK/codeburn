import { useQuery } from '@tanstack/react-query'

import { MetricCard } from '@/components/MetricCard'
import { fmtNum, usd } from '@/lib/utils'
import { getTools, type Filters, type NameRow } from '../lib/api'
import { Empty, ErrorNote, Loading, TablePanel } from '../ui'

/** `mcp__<server>__<tool>` names group by server; anything else is its own server. */
export function mcpServer(name: string): string {
  const m = /^mcp__(.+?)__/.exec(name)
  return m ? m[1]! : name
}

function NameTable({ title, filename, rows, nameLabel }: { title: string; filename: string; rows: NameRow[]; nameLabel: string }) {
  if (!rows.length) return null
  return (
    <TablePanel
      title={title}
      filename={filename}
      columns={[
        { key: 'name', label: nameLabel },
        { key: 'calls', label: 'Calls', num: true },
        { key: 'people', label: 'People', num: true },
        { key: 'cost', label: 'Spend on these calls', num: true },
      ]}
      rows={rows.map((r) => ({ name: r.name, calls: fmtNum(r.calls), people: fmtNum(r.people), cost: usd(r.cost) }))}
      csv={rows.map((r) => [r.name, r.calls, r.people, r.cost])}
    />
  )
}

/** People are counted per name, so a server row sums tool calls and takes the widest tool reach. */
function byServer(rows: NameRow[]): NameRow[] {
  const out = new Map<string, NameRow>()
  for (const r of rows) {
    const server = mcpServer(r.name)
    const cur = out.get(server) ?? { kind: 'mcp', name: server, calls: 0, cost: 0, people: 0 }
    cur.calls += r.calls
    cur.cost += r.cost
    cur.people = Math.max(cur.people, r.people)
    out.set(server, cur)
  }
  return [...out.values()].sort((a, b) => b.calls - a.calls)
}

export function Tools({ filters }: { filters: Filters }) {
  const q = useQuery({ queryKey: ['tools', filters], queryFn: () => getTools(filters) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorNote error={q.error} />
  const d = q.data!
  const mcp = d.names.filter((r) => r.kind === 'mcp')
  const skills = d.names.filter((r) => r.kind === 'skill')
  const subagents = d.names.filter((r) => r.kind === 'subagent')
  if (!d.names.length && !d.plan_mode.calls) {
    return <Empty>No MCP tool, skill, subagent or plan-mode use recorded for this period. Clients send these once they run a codeburn version that includes them.</Empty>
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="MCP servers" value={fmtNum(byServer(mcp).length)} sub={`${fmtNum(mcp.length)} tools`} />
        <MetricCard label="Skills" value={fmtNum(skills.length)} />
        <MetricCard label="Subagent types" value={fmtNum(subagents.length)} />
        <MetricCard label="Plan mode" value={`${(d.plan_mode.share * 100).toFixed(1)}%`} sub={`${fmtNum(d.plan_mode.calls)} calls by ${fmtNum(d.plan_mode.people)} people`} />
      </div>
      <p className="text-xs text-tertiary-foreground">
        Spend is the cost of the calls that used a name. A call that used two tools counts toward both, so rows do not add up to the total.
      </p>
      <NameTable title="MCP servers" filename="team-mcp-servers.csv" rows={byServer(mcp)} nameLabel="Server" />
      <NameTable title="MCP tools" filename="team-mcp-tools.csv" rows={mcp} nameLabel="Tool" />
      <div className="grid gap-4 lg:grid-cols-2">
        <NameTable title="Skills" filename="team-skills.csv" rows={skills} nameLabel="Skill" />
        <NameTable title="Subagent types" filename="team-subagents.csv" rows={subagents} nameLabel="Subagent" />
      </div>
    </div>
  )
}
