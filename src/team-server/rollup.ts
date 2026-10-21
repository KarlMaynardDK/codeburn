import type { Row, Store } from './store.js'

/** Read-side queries over daily_usage. "tokens" everywhere means input + output + cache_read + cache_write. */

export interface Filters {
  from: string
  to: string
  person?: string
  team?: string
  project?: string
}

const DAY_MS = 86_400_000
const TOKENS = 'SUM(du.input + du.output + du.cache_read + du.cache_write)'
const SUMS = `SUM(du.cost_usd) AS cost, SUM(du.input) AS input, SUM(du.output) AS output, SUM(du.cache_read) AS cache_read, SUM(du.cache_write) AS cache_write, SUM(du.calls) AS calls`

export const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
export const dayOf = (d: Date) => d.toISOString().slice(0, 10)
export const addDays = (day: string, n: number) => dayOf(new Date(Date.parse(day) + n * DAY_MS))
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < 3700; d = addDays(d, 1)) out.push(d)
  return out
}

function where(f: Filters, extra?: { from?: string; to?: string }): { sql: string; params: unknown[] } {
  const params: unknown[] = [extra?.from ?? f.from, extra?.to ?? f.to]
  let sql = 'du.day >= ? AND du.day <= ?'
  if (f.person) { sql += ' AND du.person_id = ?'; params.push(f.person) }
  if (f.team) { sql += ' AND p.team = ?'; params.push(f.team) }
  if (f.project) { sql += ' AND du.project = ?'; params.push(f.project) }
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
  const r = (await store.all(`SELECT ${SUMS}, COUNT(DISTINCT du.person_id) AS active_people ${FROM} WHERE ${w.sql}`, w.params))[0] ?? {}
  return { cost: n(r.cost), input: n(r.input), output: n(r.output), cache_read: n(r.cache_read), cache_write: n(r.cache_write), calls: n(r.calls), active_people: n(r.active_people) }
}

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
  const [t, d, byProvider, byModel, byTeam] = await Promise.all([
    totals(store, f), daily(store, f),
    breakdown(store, f, 'du.provider'), breakdown(store, f, 'du.model'), breakdown(store, f, 'p.team'),
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
    store.all(`SELECT du.person_id AS id, ${SUMS} ${FROM} WHERE ${w.sql} GROUP BY du.person_id`, w.params),
    store.all(`SELECT du.person_id AS id, du.model AS model, SUM(du.cost_usd) AS cost ${FROM} WHERE ${w.sql} GROUP BY du.person_id, du.model`, w.params),
    store.all(`SELECT du.person_id AS id, du.day AS day, SUM(du.cost_usd) AS cost ${FROM} WHERE ${w.sql} GROUP BY du.person_id, du.day`, w.params),
    store.all('SELECT person_id AS id, MAX(last_seen) AS last_seen FROM devices GROUP BY person_id'),
  ])
  const aggBy = new Map<string, Row>(agg.map(r => [r.id, r]))
  const seenBy = new Map<string, string | null>(seen.map(r => [r.id, r.last_seen ?? null]))
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
    .filter(p => (!f.person || p.id === f.person) && (!f.team || p.team === f.team) && (!f.project || aggBy.has(p.id)))
    .map(p => {
      const a = aggBy.get(p.id) ?? {}
      const row = { cost: n(a.cost), input: n(a.input), output: n(a.output), cache_read: n(a.cache_read), cache_write: n(a.cache_write), calls: n(a.calls) }
      return {
        id: p.id, name: p.name, email: p.email, team: p.team, ...row,
        cache_read_ratio: cacheReadRatio(row),
        top_model: topModel.get(p.id)?.m ?? null,
        trend: days.map(d => dayCost.get(p.id)?.get(d) ?? 0),
        last_seen: seenBy.get(p.id) ?? null,
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
  if (f.team) { sql += ' AND p.team = ?'; params.push(f.team) }
  if (f.project) { sql += ' AND s.project = ?'; params.push(f.project) }
  sql += ' ORDER BY s.started DESC LIMIT 500'
  const rows = await store.all(sql, params)
  return rows.map(r => ({ trace_id: r.trace_id, person: r.person, project: r.project, started: r.started, duration_ms: n(r.duration_ms), calls: n(r.calls), cost: n(r.cost) }))
}

/** Sessions are "stored" once any row exists. */
export async function sessionsStored(store: Store): Promise<boolean> {
  return (await store.all('SELECT 1 AS x FROM sessions LIMIT 1')).length > 0
}
