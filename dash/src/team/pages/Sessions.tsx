import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { fmtNum, fmtTokens, usd } from '@/lib/utils'
import { ApiError, getSessions, type Filters, type SessionRow } from '../lib/api'
import { Empty, ErrorNote, Loading, selectCls, TablePanel } from '../ui'

function dur(ms: number): string {
  const s = Math.round((ms || 0) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** One-shot share of the session's edit prompts; '-' when it had no edit prompts. */
function oneShot(s: SessionRow): string {
  if (s.one_shot_rate == null) return '-'
  return `${Math.round(s.one_shot_rate * 100)}% (${s.one_shot_turns}/${s.edit_turns})`
}

export function Sessions({ filters }: { filters: Filters }) {
  const [project, setProject] = useState('')
  const q = useQuery({
    queryKey: ['sessions', filters],
    queryFn: () => getSessions(filters),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  })
  const all = q.data ?? []
  const projects = useMemo(() => [...new Set(all.map((s) => s.project))].sort(), [all])
  if (q.isLoading) return <Loading />
  if (q.error instanceof ApiError && q.error.status === 404) {
    return <Empty>Session detail is not stored on this server (sessions_disabled).</Empty>
  }
  if (q.error) return <ErrorNote error={q.error} />
  const rows = all.filter((s) => !project || s.project === project)
  if (!all.length) return <Empty />
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-tertiary-foreground">
        Project
        <select className={selectCls} value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All</option>
          {projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <span>Showing newest {fmtNum(rows.length)} (max 500)</span>
      </div>
      <TablePanel
        title="Sessions"
        filename="team-sessions.csv"
        columns={[
          { key: 'started', label: 'Started' },
          { key: 'person', label: 'Person' },
          { key: 'project', label: 'Project' },
          { key: 'duration', label: 'Duration', num: true },
          { key: 'calls', label: 'Calls', num: true },
          { key: 'input', label: 'Tokens in', num: true },
          { key: 'output', label: 'Tokens out', num: true },
          { key: 'cache_read', label: 'Cache read', num: true },
          { key: 'cache_write', label: 'Cache write', num: true },
          { key: 'oneshot', label: 'One-shot', num: true },
          { key: 'cost', label: 'Cost', num: true },
        ]}
        rows={rows.map((s) => ({
          started: s.started.slice(0, 16).replace('T', ' '),
          person: s.person,
          project: s.project,
          duration: dur(s.duration_ms),
          calls: fmtNum(s.calls),
          input: fmtTokens(s.input),
          output: fmtTokens(s.output),
          cache_read: fmtTokens(s.cache_read),
          cache_write: fmtTokens(s.cache_write),
          oneshot: oneShot(s),
          cost: usd(s.cost),
        }))}
        csvHeaders={[
          'trace_id', 'started', 'person', 'project', 'duration_ms', 'calls',
          'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'edit_turns', 'one_shot_turns', 'one_shot_rate', 'cost_usd',
        ]}
        csv={rows.map((s) => [
          s.trace_id, s.started, s.person, s.project, s.duration_ms, s.calls,
          s.input, s.output, s.cache_read, s.cache_write, s.edit_turns, s.one_shot_turns, s.one_shot_rate, s.cost,
        ])}
      />
    </div>
  )
}
