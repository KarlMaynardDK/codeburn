import type { Row, Store } from './store.js'

/** Read-side queries over daily_usage. "tokens" everywhere means input + output + cache_read + cache_write. */

export interface Filters {
  from: string
  to: string
  person?: string
  team?: string
  project?: string
  /** Hard limit set by the server for a team admin: only these teams, plus the viewer's own person. Never read from the request. */
  scope?: { teams: string[]; personId: string }
}

/** SQL for the team filter and the server-set scope. `p` is the joined people table. */
export function teamClause(f: Filters, teamCol = 'p.team', idCol = 'p.id'): { sql: string; params: unknown[] } {
  let sql = ''
  const params: unknown[] = []
  if (f.team) { sql += ` AND ${teamCol} = ?`; params.push(f.team) }
  if (f.scope) {
    const marks = f.scope.teams.map(() => '?').join(', ')
    sql += f.scope.teams.length ? ` AND (${teamCol} IN (${marks}) OR ${idCol} = ?)` : ` AND ${idCol} = ?`
    params.push(...f.scope.teams, f.scope.personId)
  }
  return { sql, params }
}

/** The same rule for rows already in memory. */
export function inScope(f: Filters, p: { id?: unknown; team?: unknown }): boolean {
  if (f.team && p.team !== f.team) return false
  if (f.scope && !(f.scope.teams.includes(String(p.team)) || String(p.id) === f.scope.personId)) return false
  return true
}

const DAY_MS = 86_400_000
const TOKENS = 'SUM(du.input + du.output + du.cache_read + du.cache_write)'
const SUMS = `SUM(du.cost_usd) AS cost, SUM(du.input) AS input, SUM(du.output) AS output, SUM(du.cache_read) AS cache_read, SUM(du.cache_write) AS cache_write, SUM(du.calls) AS calls`
/** Schema v2 sums: zero for usage sent by clients that predate the fields. */
const EXTRA_COLS = [
  'reasoning', 'cache_write_1h', 'web_search', 'estimated_cost_usd', 'covered_cost_usd', 'savings_usd', 'nano_aiu',
  'lines_added', 'lines_removed', 'tool_errors', 'interrupted', 'user_modified', 'active_ms', 'tool_wait_ms',
  'turns', 'edit_turns', 'one_shot_turns', 'retries', 'plan_mode_calls',
] as const
const EXTRA_SUMS = EXTRA_COLS.map(c => `SUM(du.${c}) AS ${c}`).join(', ')
type Extras = Record<(typeof EXTRA_COLS)[number], number>
const extras = (r: Row): Extras => Object.fromEntries(EXTRA_COLS.map(c => [c, n(r[c])])) as Extras

/** Share of edit turns that landed without a retry; null when no turn data was sent. */
export function oneShotRate(r: { edit_turns: number; one_shot_turns: number }): number | null {
  return r.edit_turns > 0 ? r.one_shot_turns / r.edit_turns : null
}

export const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
export const dayOf = (d: Date) => d.toISOString().slice(0, 10)
export const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(day) + n * DAY_MS))
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < 3700; d = addDays(d, 1)) out.push(d)
  return out
}

function where(f: Filters, extra?: { from?: string; to?: string }, alias = 'du'): { sql: string; params: unknown[] } {
  const params: unknown[] = [extra?.from ?? f.from, extra?.to ?? f.to]
  let sql = `${alias}.day >= ? AND ${alias}.day <= ?`
  if (f.person) { sql += ` AND ${alias}.person_id = ?`; params.push(f.person) }
  const t = teamClause(f)
  sql += t.sql
  params.push(...t.params)
  if (f.project) { sql += ` AND ${alias}.project = ?`; params.push(f.project) }
  return { sql, params }
}

const FROM = 'FROM daily_usage du JOIN people p ON p.id = du.person_id'
const n = (v: unknown) => Number(v ?? 0)

async function breakdown(store: Store, f: Filters, col: string, withCalls = false): Promise<Array<{ name: string; cost: number; tokens: number; calls?: number }>> {
  const w = where(f)
  const rows = await store.all(`SELECT ${col} AS name, SUM(du.cost_usd) AS cost, ${TOKENS} AS tokens, SUM(du.calls) AS calls ${FROM} WHERE ${w.sql} GROUP BY ${col} ORDER BY cost DESC, name`, w.params)
  return rows.map(r => ({ name: String(r.name), cost: n(r.cost), tokens: n(r.tokens), ...(withCalls ? { calls: n(r.calls) } : {}) }))
}

async function totals(store: Store, f: Filters) {
  const w = where(f)
  const r = (await store.all(`SELECT ${SUMS}, ${EXTRA_SUMS}, COUNT(DISTINCT du.person_id) AS active_people ${FROM} WHERE ${w.sql}`, w.params))[0] ?? {}
  const x = extras(r)
  return {
    cost: n(r.cost), input: n(r.input), output: n(r.output), cache_read: n(r.cache_read), cache_write: n(r.cache_write), calls: n(r.calls),
    active_people: n(r.active_people), ...x, one_shot_rate: oneShotRate(x),
  }
}

const ROUTE_NAME = `CASE WHEN du.route = '' THEN 'direct' ELSE du.route END`
const BILLING_NAME = `CASE WHEN du.billing = '' THEN 'unknown' ELSE du.billing END`

async function daily(store: Store, f: Filters) {
  const w = where(f)
  const rows = await store.all(`SELECT du.day AS day, ${SUMS} ${FROM} WHERE ${w.sql} GROUP BY du.day`, w.params)
  const byDay = new Map(rows.map(r => [String(r.day), r]))
  return daysBetween(f.from, f.to).map(day => {
    const r = byDay.get(day) ?? {}
    return { day, cost: n(r.cost), input: n(r.input), output: n(r.output), cache_read: n(r.cache_read), cache_write: n(r.cache_write), calls: n(r.calls) }
  })
}

export async function overview(store: Store, f: Filters, compare: boolean, now = new Date()) {
  const [t, d, byProvider, byModel, byTeam, bySpeed, byRoute, byBilling] = await Promise.all([
    totals(store, f), daily(store, f),
    breakdown(store, f, 'du.provider'), breakdown(store, f, 'du.model'), breakdown(store, f, 'p.team'),
    breakdown(store, f, 'du.speed', true), breakdown(store, f, ROUTE_NAME, true), breakdown(store, f, BILLING_NAME, true),
  ])
  const today = dayOf(now)
  const monthStart = today.slice(0, 8) + '01'
  const daysElapsed = now.getUTCDate()
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const mw = where(f, { from: monthStart, to: today })
  const mr = (await store.all(`SELECT SUM(du.cost_usd) AS cost ${FROM} WHERE ${mw.sql}`, mw.params))[0]
  const mtdCost = n(mr?.cost)
  const result: Record<string, unknown> = {
    totals: t,
    daily: d,
    mtd: { cost: mtdCost, projected_month_cost: (mtdCost / daysElapsed) * daysInMonth, days_elapsed: daysElapsed, days_in_month: daysInMonth },
    by_provider: byProvider,
    by_model: byModel,
    by_team: byTeam,
    by_speed: bySpeed,
    by_route: byRoute,
    by_billing: byBilling,
  }
  if (compare) {
    const len = daysBetween(f.from, f.to).length
    const prev = await totals(store, { ...f, from: addDays(f.from, -len), to: addDays(f.from, -1) })
    result.compare = { cost: prev.cost, tokens: prev.input + prev.output + prev.cache_read + prev.cache_write }
  }
  return result
}

export function cacheReadRatio(r: { input: number; cache_read: number }): number {
  const denom = r.input + r.cache_read
  return denom > 0 ? r.cache_read / denom : 0
}

export async function people(store: Store, f: Filters) {
  const w = where(f)
  const [roster, agg, models, perDay, seen] = await Promise.all([
    store.all('SELECT id, name, email, team FROM people ORDER BY name, id'),
    store.all(`SELECT du.person_id AS id, ${SUMS}, ${EXTRA_SUMS} ${FROM} WHERE ${w.sql} GROUP BY du.person_id`, w.params),
    store.all(`SELECT du.person_id AS id, du.model AS model, SUM(du.cost_usd) AS cost ${FROM} WHERE ${w.sql} GROUP BY du.person_id, du.model`, w.params),
    store.all(`SELECT du.person_id AS id, du.day AS day, SUM(du.cost_usd) AS cost ${FROM} WHERE ${w.sql} GROUP BY du.person_id, du.day`, w.params),
    store.all(`SELECT person_id AS id, MAX(last_seen) AS last_seen, MAX(CASE WHEN revoked_at IS NULL THEN coverage_through END) AS data_through FROM devices GROUP BY person_id`),
  ])
  const aggBy = new Map<string, Row>(agg.map(r => [r.id, r]))
  const seenBy = new Map<string, Row>(seen.map(r => [r.id, r]))
  const days = daysBetween(f.from, f.to)
  const topModel = new Map<string, { m: string; c: number }>()
  for (const r of models) {
    const cur = topModel.get(r.id)
    if (!cur || n(r.cost) > cur.c) topModel.set(r.id, { m: r.model, c: n(r.cost) })
  }
  const dayCost = new Map<string, Map<string, number>>()
  for (const r of perDay) {
    if (!dayCost.has(r.id)) dayCost.set(r.id, new Map())
    dayCost.get(r.id)!.set(String(r.day), n(r.cost))
  }
  return roster
    .filter(p => (!f.person || p.id === f.person) && inScope(f, p) && (!f.project || aggBy.has(p.id)))
    .map(p => {
      const a = aggBy.get(p.id) ?? {}
      const row = { cost: n(a.cost), input: n(a.input), output: n(a.output), cache_read: n(a.cache_read), cache_write: n(a.cache_write), calls: n(a.calls) }
      const x = extras(a)
      return {
        id: p.id, name: p.name, email: p.email, team: p.team, ...row, ...x,
        cache_read_ratio: cacheReadRatio(row),
        one_shot_rate: oneShotRate(x),
        top_model: topModel.get(p.id)?.m ?? null,
        trend: days.map(d => dayCost.get(p.id)?.get(d) ?? 0),
        last_seen: seenBy.get(p.id)?.last_seen ?? null,
        data_through: seenBy.get(p.id)?.data_through ?? null,
      }
    })
}

export async function personDetail(store: Store, id: string, f: Filters) {
  const list = await people(store, { ...f, person: id })
  const person = list[0]
  if (!person) return null
  const pf = { ...f, person: id }
  const [byProvider, byModel, byProject, byCategory, d] = await Promise.all([
    breakdown(store, pf, 'du.provider', true), breakdown(store, pf, 'du.model', true),
    breakdown(store, pf, 'du.project', true), breakdown(store, pf, 'du.category', true), daily(store, pf),
  ])
  return { person, by_provider: byProvider, by_model: byModel, by_project: byProject, by_category: byCategory, daily: d }
}

export async function models(store: Store, f: Filters) {
  const w = where(f)
  const [matrix, byModel, peopleByModel] = await Promise.all([
    store.all(`SELECT du.model AS model, du.category AS category, SUM(du.cost_usd) AS cost, ${TOKENS} AS tokens, SUM(du.calls) AS calls, COUNT(DISTINCT du.person_id) AS people ${FROM} WHERE ${w.sql} GROUP BY du.model, du.category ORDER BY cost DESC, model, category`, w.params),
    breakdown(store, f, 'du.model', true),
    store.all(`SELECT du.model AS model, COUNT(DISTINCT du.person_id) AS people ${FROM} WHERE ${w.sql} GROUP BY du.model`, w.params),
  ])
  const pm = new Map(peopleByModel.map(r => [r.model, n(r.people)]))
  return {
    matrix: matrix.map(r => ({ model: r.model, category: r.category, cost: n(r.cost), tokens: n(r.tokens), calls: n(r.calls), people: n(r.people) })),
    by_model: byModel.map(m => ({ ...m, people: pm.get(m.name) ?? 0 })),
  }
}

export async function projects(store: Store, f: Filters) {
  const w = where(f)
  const [rows, perPerson] = await Promise.all([
    store.all(`SELECT du.project AS project, SUM(du.cost_usd) AS cost, ${TOKENS} AS tokens, SUM(du.calls) AS calls, COUNT(DISTINCT du.person_id) AS people ${FROM} WHERE ${w.sql} GROUP BY du.project ORDER BY cost DESC, project`, w.params),
    store.all(`SELECT du.project AS project, p.name AS name, SUM(du.cost_usd) AS cost ${FROM} WHERE ${w.sql} GROUP BY du.project, p.name, du.person_id`, w.params),
  ])
  const top = new Map<string, { name: string; cost: number }>()
  for (const r of perPerson) {
    const cur = top.get(r.project)
    if (!cur || n(r.cost) > cur.cost) top.set(r.project, { name: r.name, cost: n(r.cost) })
  }
  return rows.map(r => ({ project: r.project, cost: n(r.cost), tokens: n(r.tokens), calls: n(r.calls), people: n(r.people), top_person: top.get(r.project)?.name ?? null }))
}

export async function sessions(store: Store, f: Filters) {
  const params: unknown[] = [f.from, addDays(f.to, 1)]
  let sql = 'SELECT s.trace_id, p.name AS person, s.project, s.started, s.duration_ms, s.calls, s.cost FROM sessions s JOIN people p ON p.id = s.person_id WHERE s.started >= ? AND s.started < ?'
  if (f.person) { sql += ' AND s.person_id = ?'; params.push(f.person) }
  { const t = teamClause(f); sql += t.sql; params.push(...t.params) }
  if (f.project) { sql += ' AND s.project = ?'; params.push(f.project) }
  sql += ' ORDER BY s.started DESC LIMIT 500'
  const rows = await store.all(sql, params)
  return rows.map(r => ({ trace_id: r.trace_id, person: r.person, project: r.project, started: r.started, duration_ms: n(r.duration_ms), calls: n(r.calls), cost: n(r.cost) }))
}

const KIND_ORDER: Record<string, number> = { mcp: 0, skill: 1, subagent: 2 }

/** MCP tools, skills and subagent types, plus plan-mode use. Cost is the spend of the calls that used the name. */
export async function tools(store: Store, f: Filters) {
  const w = where(f, undefined, 'dn')
  const pw = where(f)
  const [rows, plan] = await Promise.all([
    store.all(`SELECT dn.kind AS kind, dn.name AS name, SUM(dn.calls) AS calls, SUM(dn.cost_usd) AS cost, COUNT(DISTINCT dn.person_id) AS people
      FROM daily_names dn JOIN people p ON p.id = dn.person_id WHERE ${w.sql} GROUP BY dn.kind, dn.name`, w.params),
    store.all(`SELECT SUM(du.plan_mode_calls) AS plan_calls, SUM(du.calls) AS calls, COUNT(DISTINCT CASE WHEN du.plan_mode_calls > 0 THEN du.person_id END) AS plan_people ${FROM} WHERE ${pw.sql}`, pw.params),
  ])
  const p = plan[0] ?? {}
  return {
    names: rows
      .map(r => ({ kind: String(r.kind), name: String(r.name), calls: n(r.calls), cost: n(r.cost), people: n(r.people) }))
      .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || b.calls - a.calls || a.name.localeCompare(b.name)),
    plan_mode: { calls: n(p.plan_calls), people: n(p.plan_people), share: n(p.calls) > 0 ? n(p.plan_calls) / n(p.calls) : 0 },
  }
}

function parseLinks(json: unknown): string[] {
  try {
    const v = JSON.parse(String(json ?? '[]'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Attribution rows of a project the owner hid read as 'unknown', with no PR links. */
const WS_REPO = `CASE WHEN ws.hidden = 1 THEN 'unknown' ELSE ws.repo END`
const WS_PROJECT = `CASE WHEN ws.hidden = 1 THEN 'unknown' ELSE ws.project END`
const WS_PR_LINKS = `CASE WHEN ws.hidden = 1 THEN '[]' ELSE ws.pr_links END`

/**
 * Git attribution: repos and PRs the period's sessions worked on. Spend is the session's total (from the sessions
 * table), so a session that touched two PRs counts toward both.
 */
export async function work(store: Store, f: Filters) {
  const params: unknown[] = [f.from, addDays(f.to, 1)]
  let scope = 'ws.started >= ? AND ws.started < ?'
  if (f.person) { scope += ' AND ws.person_id = ?'; params.push(f.person) }
  { const t = teamClause(f); scope += t.sql; params.push(...t.params) }
  if (f.project) { scope += ` AND ${WS_PROJECT} = ?`; params.push(f.project) }
  const [sessionRows, commitRows] = await Promise.all([
    store.all(`SELECT ws.person_id AS person_id, ${WS_REPO} AS repo, ${WS_PR_LINKS} AS pr_links, COALESCE(s.cost, 0) AS cost
      FROM work_sessions ws JOIN people p ON p.id = ws.person_id
      LEFT JOIN sessions s ON s.person_id = ws.person_id AND s.trace_id = ws.trace_id WHERE ${scope}`, params),
    store.all(`SELECT ${WS_REPO} AS repo, COUNT(DISTINCT wc.sha) AS commits,
        COUNT(DISTINCT CASE WHEN wc.in_main = 1 THEN wc.sha END) AS landed,
        COUNT(DISTINCT CASE WHEN wc.was_reverted = 1 THEN wc.sha END) AS reverted
      FROM work_commits wc JOIN work_sessions ws ON ws.person_id = wc.person_id AND ws.trace_id = wc.trace_id
      JOIN people p ON p.id = ws.person_id WHERE ${scope} GROUP BY ${WS_REPO}`, params),
  ])
  const repos = new Map<string, { repo: string; sessions: number; cost: number; people: Set<string>; prs: Set<string> }>()
  const prs = new Map<string, { url: string; repo: string; sessions: number; cost: number; people: Set<string> }>()
  for (const r of sessionRows) {
    const repo = String(r.repo)
    const cur = repos.get(repo) ?? { repo, sessions: 0, cost: 0, people: new Set<string>(), prs: new Set<string>() }
    cur.sessions++
    cur.cost += n(r.cost)
    cur.people.add(r.person_id)
    for (const url of parseLinks(r.pr_links)) {
      cur.prs.add(url)
      const pr = prs.get(url) ?? { url, repo, sessions: 0, cost: 0, people: new Set<string>() }
      pr.sessions++
      pr.cost += n(r.cost)
      pr.people.add(r.person_id)
      prs.set(url, pr)
    }
    repos.set(repo, cur)
  }
  const commitsBy = new Map(commitRows.map(r => [String(r.repo), r]))
  return {
    repos: [...repos.values()]
      .map(r => {
        const c = commitsBy.get(r.repo) ?? {}
        return { repo: r.repo, sessions: r.sessions, cost: r.cost, people: r.people.size, prs: r.prs.size, commits: n(c.commits), landed: n(c.landed), reverted: n(c.reverted) }
      })
      .sort((a, b) => b.cost - a.cost || b.sessions - a.sessions || a.repo.localeCompare(b.repo)),
    prs: [...prs.values()]
      .map(p => ({ url: p.url, repo: p.repo, sessions: p.sessions, cost: p.cost, people: p.people.size }))
      .sort((a, b) => b.cost - a.cost || b.sessions - a.sessions || a.url.localeCompare(b.url))
      .slice(0, 200),
  }
}

/** Sessions are "stored" once any row exists. */
export async function sessionsStored(store: Store): Promise<boolean> {
  return (await store.all('SELECT 1 AS x FROM sessions LIMIT 1')).length > 0
}
