import { useQuery } from '@tanstack/react-query'

import { fmtNum, usd } from '@/lib/utils'
import { ApiError, getWork, type Filters } from '../lib/api'
import { Empty, ErrorNote, Loading, TablePanel } from '../ui'

/** github.com/owner/repo/pull/12 -> owner/repo#12 */
function prLabel(url: string): string {
  const m = /^https:\/\/[^/]+\/(.+?)\/(?:pull|merge_requests|-\/merge_requests)\/(\d+)/.exec(url)
  return m ? `${m[1]}#${m[2]}` : url
}

export function Work({ filters }: { filters: Filters }) {
  const q = useQuery({
    queryKey: ['work', filters],
    queryFn: () => getWork(filters),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 1,
  })
  if (q.isLoading) return <Loading />
  if (q.error instanceof ApiError && q.error.status === 404) {
    return <Empty>Git attribution needs session detail, which this server does not store (sessions_disabled).</Empty>
  }
  if (q.error) return <ErrorNote error={q.error} />
  const d = q.data!
  if (!d.repos.length) {
    return <Empty>No git attribution for this period. Clients send it with codeburn sync push --attribution at the sessions detail level.</Empty>
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-tertiary-foreground">
        Sessions are matched to commits by time window, so this is an estimate. Spend is each session&apos;s total; a session that touched two PRs counts toward both.
      </p>
      <TablePanel
        title="Repositories"
        filename="team-repos.csv"
        columns={[
          { key: 'repo', label: 'Repository' },
          { key: 'cost', label: 'Session spend', num: true },
          { key: 'sessions', label: 'Sessions', num: true },
          { key: 'people', label: 'People', num: true },
          { key: 'prs', label: 'PRs', num: true },
          { key: 'commits', label: 'Commits', num: true },
          { key: 'landed', label: 'In main', num: true },
          { key: 'reverted', label: 'Reverted', num: true },
          { key: 'perCommit', label: 'Per landed commit', num: true },
        ]}
        rows={d.repos.map((r) => ({
          repo: r.repo,
          cost: usd(r.cost),
          sessions: fmtNum(r.sessions),
          people: fmtNum(r.people),
          prs: fmtNum(r.prs),
          commits: fmtNum(r.commits),
          landed: fmtNum(r.landed),
          reverted: fmtNum(r.reverted),
          perCommit: r.landed ? usd(r.cost / r.landed) : '-',
        }))}
        csv={d.repos.map((r) => [r.repo, r.cost, r.sessions, r.people, r.prs, r.commits, r.landed, r.reverted])}
      />
      {d.prs.length ? (
        <TablePanel
          title="Pull requests"
          filename="team-prs.csv"
          columns={[
            { key: 'pr', label: 'Pull request' },
            { key: 'cost', label: 'Session spend', num: true },
            { key: 'sessions', label: 'Sessions', num: true },
            { key: 'people', label: 'People', num: true },
          ]}
          rows={d.prs.map((p) => ({
            pr: (
              <a className="text-primary hover:underline" href={p.url} target="_blank" rel="noreferrer noopener">
                {prLabel(p.url)}
              </a>
            ),
            cost: usd(p.cost),
            sessions: fmtNum(p.sessions),
            people: fmtNum(p.people),
          }))}
          csv={d.prs.map((p) => [p.url, p.repo, p.cost, p.sessions, p.people])}
        />
      ) : null}
    </div>
  )
}
