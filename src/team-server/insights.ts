import type { Store } from './store.js'
import { addDays, cacheReadRatio, type Filters } from './rollup.js'

/** Models whose lowercase name contains any of these count as premium. */
export const PREMIUM_MODEL_PATTERNS = ['opus', 'gpt-5', 'o3', 'pro']
/** Task categories (src/classifier.ts TaskCategory plus the "unknown" fallback) where a premium model is rarely worth it. */
export const SIMPLE_CATEGORIES = new Set(['conversation', 'exploration', 'general', 'unknown'])

export const MIN_SPEND_FOR_CACHE_RULE = 1
export const MIN_PEERS_FOR_CACHE_RULE = 3
export const MIN_SIMPLE_SPEND = 1
export const SPIKE_FACTOR = 2
export const SPIKE_MIN_INCREASE_USD = 5

export const isPremiumModel = (model: string) => {
  const m = model.toLowerCase()
  return PREMIUM_MODEL_PATTERNS.some(p => m.includes(p))
}

export interface Insight {
  id: string
  severity: 'info' | 'warn'
  title: string
  detail: string
  person?: string
  value?: number
}

const n = (v: unknown) => Number(v ?? 0)
const pct = (x: number) => `${Math.round(x * 100)}%`
const usd = (x: number) => `$${x.toFixed(2)}`

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

function scope(f: Filters, alias = 'du'): { sql: string; params: unknown[] } {
  let sql = ''
  const params: unknown[] = []
  if (f.person) { sql += ` AND ${alias}.person_id = ?`; params.push(f.person) }
  if (f.team) { sql += ' AND p.team = ?'; params.push(f.team) }
  if (f.project) { sql += ` AND ${alias}.project = ?`; params.push(f.project) }
  return { sql, params }
}

export async function computeInsights(store: Store, f: Filters, opts: { includeFindings: boolean }) {
  const insights: Insight[] = []
  const sc = scope(f)

  // Rule 1: cache-read ratio well below the team median.
  const perPerson = await store.all(
    `SELECT p.id AS id, p.name AS name, SUM(du.cost_usd) AS cost, SUM(du.input) AS input, SUM(du.cache_read) AS cache_read
     FROM daily_usage du JOIN people p ON p.id = du.person_id WHERE du.day >= ? AND du.day <= ?${sc.sql} GROUP BY p.id, p.name`,
    [f.from, f.to, ...sc.params])
  const eligible = perPerson
    .filter(r => n(r.cost) >= MIN_SPEND_FOR_CACHE_RULE)
    .map(r => ({ id: r.id as string, name: r.name as string, ratio: cacheReadRatio({ input: n(r.input), cache_read: n(r.cache_read) }) }))
  if (eligible.length >= MIN_PEERS_FOR_CACHE_RULE) {
    const med = median(eligible.map(e => e.ratio))
    for (const e of eligible) {
      if (med > 0 && e.ratio < med * 0.5) {
        insights.push({
          id: 'low-cache-read', severity: 'warn', person: e.name, value: e.ratio,
          title: `${e.name} has a low cache-read ratio`,
          detail: `Cache reads are ${pct(e.ratio)} of input, against a team median of ${pct(med)}. Longer-lived sessions and stable prompt prefixes usually raise this.`,
        })
      }
    }
  }

  // Rule 2: premium models used on simple categories.
  const catRows = await store.all(
    `SELECT p.name AS name, du.model AS model, du.category AS category, SUM(du.cost_usd) AS cost
     FROM daily_usage du JOIN people p ON p.id = du.person_id WHERE du.day >= ? AND du.day <= ?${sc.sql} GROUP BY p.name, du.person_id, du.model, du.category`,
    [f.from, f.to, ...sc.params])
  const simple = new Map<string, { total: number; premium: number }>()
  for (const r of catRows) {
    if (!SIMPLE_CATEGORIES.has(String(r.category))) continue
    const cur = simple.get(r.name) ?? { total: 0, premium: 0 }
    cur.total += n(r.cost)
    if (isPremiumModel(String(r.model))) cur.premium += n(r.cost)
    simple.set(r.name, cur)
  }
  for (const [name, s] of simple) {
    if (s.total >= MIN_SIMPLE_SPEND && s.premium / s.total > 0.5) {
      insights.push({
        id: 'premium-on-simple', severity: 'warn', person: name, value: s.premium / s.total,
        title: `${name} runs premium models on simple tasks`,
        detail: `${pct(s.premium / s.total)} of ${usd(s.total)} spent on conversation, exploration and general work went to premium models. A smaller model would likely do.`,
      })
    }
  }

  // Rule 3: week-over-week spike, anchored on the end of the period.
  const wkFrom = addDays(f.to, -6)
  const prevFrom = addDays(f.to, -13)
  const wk = await store.all(
    `SELECT p.name AS name,
       SUM(CASE WHEN du.day >= ? THEN du.cost_usd ELSE 0 END) AS cur,
       SUM(CASE WHEN du.day < ? THEN du.cost_usd ELSE 0 END) AS prev
     FROM daily_usage du JOIN people p ON p.id = du.person_id WHERE du.day >= ? AND du.day <= ?${sc.sql} GROUP BY p.id, p.name`,
    [wkFrom, wkFrom, prevFrom, f.to, ...sc.params])
  for (const r of wk) {
    const cur = n(r.cur)
    const prev = n(r.prev)
    if (cur > prev * SPIKE_FACTOR && cur - prev > SPIKE_MIN_INCREASE_USD) {
      insights.push({
        id: 'spend-spike', severity: 'warn', person: r.name, value: cur,
        title: `${r.name}'s spend spiked week over week`,
        detail: `${usd(cur)} in the last 7 days against ${usd(prev)} the week before.`,
      })
    }
  }

  const out: { insights: Insight[]; findings?: Array<{ title: string; people: number; estimated_savings_usd: number }> } = { insights }
  if (opts.includeFindings) out.findings = await aggregateFindings(store, f)
  return out
}

/** Groups optimize findings by id across people; savings are summed per person-snapshot. */
export async function aggregateFindings(store: Store, f: Filters) {
  const params: unknown[] = []
  let sql = 'SELECT fi.person_id AS person_id, fi.json AS json FROM findings fi JOIN people p ON p.id = fi.person_id WHERE 1 = 1'
  if (f.person) { sql += ' AND fi.person_id = ?'; params.push(f.person) }
  if (f.team) { sql += ' AND p.team = ?'; params.push(f.team) }
  const rows = await store.all(sql, params)
  const groups = new Map<string, { title: string; people: Set<string>; savings: number }>()
  for (const r of rows) {
    let doc: { findings?: Array<{ id?: string; title?: string; estimatedSavingsUSD?: number }> }
    try { doc = JSON.parse(String(r.json)) } catch { continue }
    for (const item of Array.isArray(doc.findings) ? doc.findings : []) {
      const title = typeof item.title === 'string' ? item.title : null
      const key = typeof item.id === 'string' ? item.id : title
      if (!key || !title) continue
      const g = groups.get(key) ?? { title, people: new Set<string>(), savings: 0 }
      g.people.add(r.person_id)
      g.savings += Number.isFinite(item.estimatedSavingsUSD) ? Number(item.estimatedSavingsUSD) : 0
      groups.set(key, g)
    }
  }
  return [...groups.values()]
    .map(g => ({ title: g.title, people: g.people.size, estimated_savings_usd: g.savings }))
    .sort((a, b) => b.people - a.people || b.estimated_savings_usd - a.estimated_savings_usd)
    .slice(0, 20)
}
