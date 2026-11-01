import type { Store } from './store.js'
import { addDays, cacheReadRatio, type Filters } from './rollup.js'
import { parseCoaching, type CoachingSnapshot } from './coaching.js'

/** Models whose lowercase name contains any of these count as premium. */
export const PREMIUM_MODEL_PATTERNS = ['opus', 'gpt-5', 'o3', 'pro']
/** Task categories (src/classifier.ts TaskCategory plus the "unknown" fallback) where a premium model is rarely worth it. */
export const SIMPLE_CATEGORIES = new Set(['conversation', 'exploration', 'general', 'unknown'])

/** Rules that compare a person with their peers need at least this many people with enough data (small teams are common). */
export const MIN_PEERS = 2
export const MIN_SPEND_FOR_CACHE_RULE = 1
export const MIN_SIMPLE_SPEND = 1
export const SPIKE_FACTOR = 2
export const SPIKE_MIN_INCREASE_USD = 5
export const MIN_EDIT_TURNS = 10
/** Absolute gap below the median one-shot rate that triggers the rule. */
export const ONE_SHOT_GAP = 0.2
export const MIN_CALLS_FOR_ERROR_RULE = 50
export const MIN_TOOL_ERROR_RATE = 0.05
export const MIN_INTERRUPT_RATE = 0.05
export const FAST_SHARE_INFO = 0.25
// Absolute thresholds that mirror the coaching notes of the local `codeburn report` (src/workflow-insights.ts), so they
// apply to a single person and need no peers.
/** A task category needs this many edit prompts before its one-shot rate counts. */
export const MIN_CATEGORY_EDIT_TURNS = 5
export const ONE_SHOT_LOW = 0.6
export const CORRECTION_HIGH_RATE = 0.15
export const CORRECTION_MIN_COUNT = 3
export const SLOW_FIRST_EDIT_MS = 5 * 60 * 1000
export const MIN_SESSIONS_FOR_FIRST_EDIT = 3

export const isPremiumModel = (model: string) => {
  const m = model.toLowerCase()
  return PREMIUM_MODEL_PATTERNS.some(p => m.includes(p))
}

/** training: how someone works with the assistant. cost: spend to watch. setup: configuration or missing data. */
export type InsightKind = 'training' | 'cost' | 'setup'

export interface EvidenceTable {
  title: string
  columns: string[]
  rows: string[][]
}

export interface Insight {
  id: string
  severity: 'info' | 'warn'
  kind: InsightKind
  title: string
  detail: string
  person?: string
  person_id?: string
  value?: number
  /** The numbers behind the insight, preformatted for display. */
  evidence?: EvidenceTable[]
  /** What the person (or their lead) can try. */
  action?: string
}

export interface Finding {
  title: string
  people: number
  names: string[]
  estimated_savings_usd: number
}

const n = (v: unknown) => Number(v ?? 0)
const pct = (x: number) => `${Math.round(x * 100)}%`
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`
const usd = (x: number) => `$${x.toFixed(2)}`
const rate = (a: number, b: number): number | null => (b > 0 ? a / b : null)

const CATEGORY_LABELS: Record<string, string> = {
  coding: 'Coding', debugging: 'Debugging', feature: 'Feature dev', refactoring: 'Refactoring', testing: 'Testing',
  exploration: 'Exploration', planning: 'Planning', delegation: 'Delegation', git: 'Git ops', 'build/deploy': 'Build/deploy',
  conversation: 'Conversation', brainstorming: 'Brainstorming', general: 'General', unknown: 'Unknown',
}
const catLabel = (c: string) => CATEGORY_LABELS[c] ?? c

function duration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 1000)} s`
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** The median of the values, or null when fewer than MIN_PEERS people have one. */
function peerMedian(xs: number[]): number | null {
  return xs.length >= MIN_PEERS ? median(xs) : null
}

function scope(f: Filters, alias = 'du'): { sql: string; params: unknown[] } {
  let sql = ''
  const params: unknown[] = []
  if (f.person) { sql += ` AND ${alias}.person_id = ?`; params.push(f.person) }
  if (f.team) { sql += ' AND p.team = ?'; params.push(f.team) }
  if (f.project) { sql += ` AND ${alias}.project = ?`; params.push(f.project) }
  return { sql, params }
}

interface Agg {
  id: string
  name: string
  team: string
  cost: number
  calls: number
  input: number
  cache_read: number
  edit_turns: number
  one_shot: number
  retries: number
  plan_calls: number
  interrupted: number
  tool_errors: number
  fast: number
  cats: Map<string, { edit: number; one: number }>
  simpleTotal: number
  simplePremium: number
  premiumSimple: Map<string, { model: string; category: string; cost: number }>
  premiumSimpleProjects: Map<string, number>
}

async function loadAggs(store: Store, f: Filters): Promise<Agg[]> {
  const sc = scope(f)
  const rows = await store.all(
    `SELECT p.id AS id, p.name AS name, p.team AS team, du.project AS project, du.model AS model, du.category AS category, du.speed AS speed,
       SUM(du.cost_usd) AS cost, SUM(du.calls) AS calls, SUM(du.input) AS input, SUM(du.cache_read) AS cache_read,
       SUM(du.edit_turns) AS edit_turns, SUM(du.one_shot_turns) AS one_shot_turns, SUM(du.retries) AS retries,
       SUM(du.plan_mode_calls) AS plan_calls, SUM(du.interrupted) AS interrupted, SUM(du.tool_errors) AS tool_errors
     FROM daily_usage du JOIN people p ON p.id = du.person_id WHERE du.day >= ? AND du.day <= ?${sc.sql}
     GROUP BY p.id, p.name, p.team, du.project, du.model, du.category, du.speed`,
    [f.from, f.to, ...sc.params])
  const byId = new Map<string, Agg>()
  for (const r of rows) {
    let a = byId.get(r.id)
    if (!a) {
      a = {
        id: r.id, name: String(r.name), team: String(r.team ?? ''), cost: 0, calls: 0, input: 0, cache_read: 0, edit_turns: 0, one_shot: 0,
        retries: 0, plan_calls: 0, interrupted: 0, tool_errors: 0, fast: 0, cats: new Map(), simpleTotal: 0, simplePremium: 0,
        premiumSimple: new Map(), premiumSimpleProjects: new Map(),
      }
      byId.set(r.id, a)
    }
    const cost = n(r.cost)
    a.cost += cost
    a.calls += n(r.calls)
    a.input += n(r.input)
    a.cache_read += n(r.cache_read)
    a.edit_turns += n(r.edit_turns)
    a.one_shot += n(r.one_shot_turns)
    a.retries += n(r.retries)
    a.plan_calls += n(r.plan_calls)
    a.interrupted += n(r.interrupted)
    a.tool_errors += n(r.tool_errors)
    if (r.speed === 'fast') a.fast += cost
    const category = String(r.category)
    if (n(r.edit_turns) > 0) {
      const c = a.cats.get(category) ?? { edit: 0, one: 0 }
      c.edit += n(r.edit_turns)
      c.one += n(r.one_shot_turns)
      a.cats.set(category, c)
    }
    if (SIMPLE_CATEGORIES.has(category)) {
      a.simpleTotal += cost
      if (isPremiumModel(String(r.model))) {
        a.simplePremium += cost
        const key = `${r.model}\u0000${category}`
        const cur = a.premiumSimple.get(key) ?? { model: String(r.model), category, cost: 0 }
        cur.cost += cost
        a.premiumSimple.set(key, cur)
        a.premiumSimpleProjects.set(String(r.project), (a.premiumSimpleProjects.get(String(r.project)) ?? 0) + cost)
      }
    }
  }
  return [...byId.values()]
}

async function loadSnapshots(store: Store, f: Filters): Promise<Map<string, { at: string; snap: CoachingSnapshot }>> {
  const out = new Map<string, { at: string; snap: CoachingSnapshot }>()
  let sql = 'SELECT c.person_id AS person_id, c.captured_at AS captured_at, c.json AS json FROM coaching c JOIN people p ON p.id = c.person_id WHERE 1 = 1'
  const params: unknown[] = []
  if (f.person) { sql += ' AND c.person_id = ?'; params.push(f.person) }
  if (f.team) { sql += ' AND p.team = ?'; params.push(f.team) }
  for (const r of await store.all(sql, params)) {
    let snap: CoachingSnapshot | null = null
    try { snap = parseCoaching(JSON.parse(String(r.json))) } catch { /* ignore a corrupt row */ }
    if (snap) out.set(r.person_id, { at: String(r.captured_at).slice(0, 10), snap })
  }
  return out
}

export interface TeamMedians {
  one_shot_rate: number | null
  retries_per_edit: number | null
  plan_share: number | null
  interrupted_rate: number | null
  cache_ratio: number | null
  tool_error_rate: number | null
}

interface Analysis {
  insights: Insight[]
  aggs: Agg[]
  snapshots: Map<string, { at: string; snap: CoachingSnapshot }>
  medians: TeamMedians
}

const table = (title: string, columns: string[], rows: string[][]): EvidenceTable => ({ title, columns, rows })

async function analyse(store: Store, f: Filters, opts: { includeCoaching: boolean }): Promise<Analysis> {
  const insights: Insight[] = []
  const aggs = await loadAggs(store, f)
  const sc = scope(f)
  const add = (i: Insight) => { insights.push(i) }
  const who = (a: Agg) => ({ person: a.name, person_id: a.id })

  // Team medians, each over the people with enough data for that measure.
  const cacheEligible = aggs.filter(a => a.cost >= MIN_SPEND_FOR_CACHE_RULE)
  const oneShotEligible = aggs.filter(a => a.edit_turns >= MIN_EDIT_TURNS)
  const callsEligible = aggs.filter(a => a.calls >= MIN_CALLS_FOR_ERROR_RULE)
  const cacheOf = (a: Agg) => cacheReadRatio({ input: a.input, cache_read: a.cache_read })
  const medians: TeamMedians = {
    cache_ratio: peerMedian(cacheEligible.map(cacheOf)),
    one_shot_rate: peerMedian(oneShotEligible.map(a => a.one_shot / a.edit_turns)),
    retries_per_edit: peerMedian(oneShotEligible.map(a => a.retries / a.edit_turns)),
    plan_share: peerMedian(callsEligible.map(a => a.plan_calls / a.calls)),
    interrupted_rate: peerMedian(callsEligible.map(a => a.interrupted / a.calls)),
    tool_error_rate: peerMedian(callsEligible.map(a => a.tool_errors / a.calls)),
  }
  const medOrDash = (v: number | null, fmt: (x: number) => string) => (v === null ? '-' : fmt(v))

  // Task categories: each person's one-shot rate per category against the team's.
  const catMedian = new Map<string, number>()
  for (const c of new Set(aggs.flatMap(a => [...a.cats.keys()]))) {
    const m = peerMedian(aggs.map(a => a.cats.get(c)).filter((x): x is { edit: number; one: number } => !!x && x.edit >= MIN_CATEGORY_EDIT_TURNS).map(x => x.one / x.edit))
    if (m !== null) catMedian.set(c, m)
  }
  const categoryTable = (a: Agg): EvidenceTable => table(
    'One-shot rate by task type (edit prompts that landed without a retry)',
    ['Task type', 'Edit prompts', 'One-shot', 'Team median'],
    [...a.cats.entries()]
      .filter(([, c]) => c.edit >= MIN_CATEGORY_EDIT_TURNS)
      .sort((x, y) => x[1].one / x[1].edit - y[1].one / y[1].edit)
      .slice(0, 6)
      .map(([cat, c]) => [catLabel(cat), String(c.edit), pct(c.one / c.edit), medOrDash(catMedian.get(cat) ?? null, pct)]))

  // Cache-read ratio well below the team median.
  if (medians.cache_ratio !== null && medians.cache_ratio > 0) {
    for (const a of cacheEligible) {
      const ratio = cacheOf(a)
      if (ratio >= medians.cache_ratio * 0.5) continue
      const evidence = [table('Cache use', ['Measure', a.name, 'Team median'], [
        ['Cache reads as a share of input', pct(ratio), pct(medians.cache_ratio)],
        ['Spend in this period', usd(a.cost), '-'],
      ])]
      const ses = (await store.all(
        'SELECT COUNT(*) AS n, AVG(duration_ms) AS avg_ms FROM sessions WHERE person_id = ? AND started >= ? AND started < ?',
        [a.id, f.from, addDays(f.to, 1)]))[0]
      if (n(ses?.n) > 0) evidence.push(table('Sessions', ['Measure', a.name], [['Sessions', String(n(ses?.n))], ['Average length', duration(n(ses?.avg_ms))]]))
      add({
        id: 'low-cache-read', severity: 'warn', kind: 'training', ...who(a), value: ratio,
        title: `${a.name} has a low cache-read ratio`,
        detail: `Cache reads are ${pct(ratio)} of input, against a team median of ${pct(medians.cache_ratio)}. Longer-lived sessions and stable prompt prefixes usually raise this.`,
        action: 'Keep one session going for related work instead of starting a new one for each question, and avoid editing CLAUDE.md or other instructions mid-session. Both reset the cache.',
        evidence,
      })
    }
  }

  // Premium models used on simple categories.
  for (const a of aggs) {
    if (a.simpleTotal < MIN_SIMPLE_SPEND || a.simplePremium / a.simpleTotal <= 0.5) continue
    const share = a.simplePremium / a.simpleTotal
    const rows = [...a.premiumSimple.values()].sort((x, y) => y.cost - x.cost)
    add({
      id: 'premium-on-simple', severity: 'warn', kind: 'training', ...who(a), value: share,
      title: `${a.name} runs premium models on simple tasks`,
      detail: `${pct(share)} of ${usd(a.simpleTotal)} spent on conversation, exploration and general work went to premium models, mostly ${rows[0]!.model}. A smaller model would likely do.`,
      action: 'Switch to a mid-tier model (for example with /model) for questions, exploration and quick lookups, and keep the premium model for planning, debugging and multi-file changes.',
      evidence: [
        table('Premium spend on simple work', ['Model', 'Task type', 'Spend', 'Share of simple spend'],
          rows.slice(0, 5).map(r => [r.model, catLabel(r.category), usd(r.cost), pct(r.cost / a.simpleTotal)])),
        table('Where it happened', ['Project', 'Premium spend'],
          [...a.premiumSimpleProjects.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([p, c]) => [p, usd(c)])),
      ],
    })
  }

  // Week-over-week spike, anchored on the end of the period.
  const wkFrom = addDays(f.to, -6)
  const prevFrom = addDays(f.to, -13)
  const wk = await store.all(
    `SELECT p.id AS id, p.name AS name,
       SUM(CASE WHEN du.day >= ? THEN du.cost_usd ELSE 0 END) AS cur,
       SUM(CASE WHEN du.day < ? THEN du.cost_usd ELSE 0 END) AS prev
     FROM daily_usage du JOIN people p ON p.id = du.person_id WHERE du.day >= ? AND du.day <= ?${sc.sql} GROUP BY p.id, p.name`,
    [wkFrom, wkFrom, prevFrom, f.to, ...sc.params])
  for (const r of wk) {
    const cur = n(r.cur)
    const prev = n(r.prev)
    if (!(cur > prev * SPIKE_FACTOR && cur - prev > SPIKE_MIN_INCREASE_USD)) continue
    const grew = await store.all(
      `SELECT du.project AS project, du.model AS model,
         SUM(CASE WHEN du.day >= ? THEN du.cost_usd ELSE 0 END) AS cur,
         SUM(CASE WHEN du.day < ? THEN du.cost_usd ELSE 0 END) AS prev
       FROM daily_usage du JOIN people p ON p.id = du.person_id WHERE du.person_id = ? AND du.day >= ? AND du.day <= ?${f.project ? ' AND du.project = ?' : ''}
       GROUP BY du.project, du.model`,
      [wkFrom, wkFrom, r.id, prevFrom, f.to, ...(f.project ? [f.project] : [])])
    add({
      id: 'spend-spike', severity: 'warn', kind: 'cost', person: r.name, person_id: r.id, value: cur,
      title: `${r.name}'s spend spiked week over week`,
      detail: `${usd(cur)} in the last 7 days against ${usd(prev)} the week before.`,
      action: 'Check whether the increase is planned work. Long autonomous runs, large contexts and a premium model left on for routine work are the usual causes.',
      evidence: [table('What grew most', ['Project', 'Model', 'Last 7 days', 'Week before'],
        grew.map(g => ({ g, d: n(g.cur) - n(g.prev) })).filter(x => x.d > 0).sort((x, y) => y.d - x.d).slice(0, 4)
          .map(({ g }) => [String(g.project), String(g.model), usd(n(g.cur)), usd(n(g.prev))]))],
    })
  }

  // One-shot rate. Relative: well below the team median. Absolute: a task type below the report's coaching threshold.
  const relativeOneShot = new Set<string>()
  if (medians.one_shot_rate !== null) {
    for (const a of oneShotEligible) {
      const r = a.one_shot / a.edit_turns
      if (r >= medians.one_shot_rate - ONE_SHOT_GAP) continue
      relativeOneShot.add(a.id)
      const retries = a.retries / a.edit_turns
      const weakest = [...a.cats.entries()].filter(([, c]) => c.edit >= MIN_CATEGORY_EDIT_TURNS).sort((x, y) => x[1].one / x[1].edit - y[1].one / y[1].edit)[0]
      add({
        id: 'low-one-shot', severity: 'info', kind: 'training', ...who(a), value: r,
        title: `${a.name} often needs retries on edits`,
        detail: `${pct(r)} of edit prompts landed without a retry, against a team median of ${pct(medians.one_shot_rate)}${weakest ? `; weakest in ${catLabel(weakest[0])} (${pct(weakest[1].one / weakest[1].edit)} over ${weakest[1].edit} prompts)` : ''}. More context up front or plan mode may help.`,
        action: 'State the constraints and the files involved in the first message, split large changes into smaller edits, and use plan mode before multi-file work.',
        evidence: [
          table('Edit prompts', ['Measure', a.name, 'Team median'], [
            ['Edit prompts', String(a.edit_turns), '-'],
            ['One-shot rate', pct(r), pct(medians.one_shot_rate)],
            ['Retries per edit prompt', retries.toFixed(2), medOrDash(medians.retries_per_edit, x => x.toFixed(2))],
          ]),
          categoryTable(a),
        ],
      })
    }
  }
  for (const a of aggs) {
    if (relativeOneShot.has(a.id)) continue
    const weak = [...a.cats.entries()].filter(([, c]) => c.edit >= MIN_CATEGORY_EDIT_TURNS && c.one / c.edit < ONE_SHOT_LOW).sort((x, y) => x[1].one / x[1].edit - y[1].one / y[1].edit)[0]
    if (!weak) continue
    add({
      id: 'weak-task-type', severity: 'info', kind: 'training', ...who(a), value: weak[1].one / weak[1].edit,
      title: `${a.name} struggles to land ${catLabel(weak[0]).toLowerCase()} edits first time`,
      detail: `One-shot rate on ${catLabel(weak[0])} is ${pct(weak[1].one / weak[1].edit)} over ${weak[1].edit} edit prompts. Add the constraints up front or split the work into smaller edits.`,
      action: 'Walk through a recent failed prompt of this type together: what context was missing, and could it have been split?',
      evidence: [categoryTable(a)],
    })
  }

  // Low one-shot rate and no plan mode.
  for (const a of oneShotEligible) {
    const r = a.one_shot / a.edit_turns
    if (r >= ONE_SHOT_LOW || a.plan_calls > 0) continue
    add({
      id: 'no-plan-mode', severity: 'info', kind: 'training', ...who(a), value: r,
      title: `${a.name} has not used plan mode`,
      detail: `${pct(r)} of ${a.edit_turns} edit prompts landed first time and no call used plan mode. Planning first usually cuts retries on larger changes.`,
      action: 'Show them plan mode (Shift+Tab twice in Claude Code) and ask for it before multi-file or unfamiliar changes.',
      evidence: [table('Plan mode', ['Measure', a.name, 'Team median'], [
        ['Calls using plan mode', String(a.plan_calls), '-'],
        ['Share of calls in plan mode', pct1(a.plan_calls / Math.max(a.calls, 1)), medOrDash(medians.plan_share, pct1)],
        ['One-shot rate', pct(r), medOrDash(medians.one_shot_rate, pct)],
      ])],
    })
  }

  // Tool error rate well above the team median.
  if (medians.tool_error_rate !== null) {
    for (const a of callsEligible) {
      const r = a.tool_errors / a.calls
      if (!(r >= MIN_TOOL_ERROR_RATE && r > medians.tool_error_rate * 2)) continue
      const mcp = await store.all(
        `SELECT dn.name AS name, SUM(dn.calls) AS calls FROM daily_names dn WHERE dn.person_id = ? AND dn.kind = 'mcp' AND dn.day >= ? AND dn.day <= ?
         GROUP BY dn.name ORDER BY SUM(dn.calls) DESC LIMIT 5`, [a.id, f.from, f.to])
      add({
        id: 'tool-errors', severity: 'warn', kind: 'setup', ...who(a), value: r,
        title: `${a.name} hits many tool errors`,
        detail: `${(r * 100).toFixed(1)} failed tool calls per 100 calls, against a team median of ${(medians.tool_error_rate * 100).toFixed(1)}. A broken MCP server or a missing permission is a common cause.`,
        action: 'Run /mcp and check the permission settings on their machine, and look for an MCP server that is failing or timing out.',
        evidence: [
          table('Tool errors', ['Measure', a.name, 'Team median'], [
            ['Calls', String(Math.round(a.calls)), '-'],
            ['Failed tool calls', String(Math.round(a.tool_errors)), '-'],
            ['Failed per 100 calls', (r * 100).toFixed(1), (medians.tool_error_rate * 100).toFixed(1)],
          ]),
          ...(mcp.length ? [table('Most used MCP tools', ['Tool', 'Calls'], mcp.map(m => [String(m.name), String(Math.round(n(m.calls)))]))] : []),
        ],
      })
    }
  }

  // Frequent interruptions.
  if (medians.interrupted_rate !== null) {
    for (const a of callsEligible) {
      const r = a.interrupted / a.calls
      if (!(r >= MIN_INTERRUPT_RATE && r > medians.interrupted_rate * 2)) continue
      add({
        id: 'frequent-interrupts', severity: 'info', kind: 'training', ...who(a), value: r,
        title: `${a.name} interrupts the assistant often`,
        detail: `${pct1(r)} of calls were interrupted, against a team median of ${pct1(medians.interrupted_rate)}. Frequent interruptions often mean the first prompt did not say enough about the goal.`,
        action: 'State the goal and the constraints in the first message, and use plan mode so the direction is agreed before the assistant starts editing.',
        evidence: [table('Interruptions', ['Measure', a.name, 'Team median'], [
          ['Calls', String(Math.round(a.calls)), '-'],
          ['Interrupted calls', String(Math.round(a.interrupted)), '-'],
          ['Share interrupted', pct1(r), pct1(medians.interrupted_rate)],
        ])],
      })
    }
  }

  // Fast mode, which bills at a premium; names who uses it.
  const totalCost = aggs.reduce((s, a) => s + a.cost, 0)
  const totalFast = aggs.reduce((s, a) => s + a.fast, 0)
  if (totalCost > 0 && totalFast / totalCost >= FAST_SHARE_INFO) {
    add({
      id: 'fast-mode-share', severity: 'info', kind: 'cost', value: totalFast / totalCost,
      title: 'Fast mode is a large share of spend',
      detail: `${usd(totalFast)} of ${usd(totalCost)} (${pct(totalFast / totalCost)}) ran in fast mode, which is billed at a premium.`,
      action: 'Keep fast mode for interactive work where waiting hurts, and turn it off for long or background runs.',
      evidence: [table('Fast mode spend by person', ['Person', 'Fast spend', 'Share of their spend'],
        aggs.filter(a => a.fast > 0).sort((x, y) => y.fast - x.fast).slice(0, 8).map(a => [a.name, usd(a.fast), pct(a.fast / a.cost)]))],
    })
  }

  // Coaching snapshots: counts clients computed locally. Not tied to the period or project filters.
  const snapshots = opts.includeCoaching ? await loadSnapshots(store, f) : new Map<string, { at: string; snap: CoachingSnapshot }>()
  if (opts.includeCoaching && !f.project) {
    for (const a of aggs) {
      const s = snapshots.get(a.id)
      if (!s) continue
      const { snap, at } = s
      const window = `${snap.period.label ?? 'last 30 days'} to ${at}`
      const corrRate = rate(snap.corrections, snap.user_turns)
      if (corrRate !== null && corrRate >= CORRECTION_HIGH_RATE && snap.corrections >= CORRECTION_MIN_COUNT) {
        add({
          id: 'frequent-corrections', severity: 'warn', kind: 'training', ...who(a), value: corrRate,
          title: `${a.name} often has to correct the assistant`,
          detail: `${pct(corrRate)} of prompts (${snap.corrections} of ${snap.user_turns}) told the assistant it had it wrong. State the requirements in the first message to cut the back and forth.`,
          action: 'Look at what they ask for first and what they have to add afterwards. Usually a missing requirement, example or constraint.',
          evidence: [table(`Corrections (${window})`, ['Measure', a.name], [['Prompts', String(snap.user_turns)], ['Corrections', String(snap.corrections)], ['Share of prompts', pct(corrRate)]])],
        })
      }
      if (snap.median_time_to_first_edit_ms !== null && snap.median_time_to_first_edit_ms >= SLOW_FIRST_EDIT_MS && snap.sessions_with_edits >= MIN_SESSIONS_FOR_FIRST_EDIT) {
        add({
          id: 'slow-first-edit', severity: 'info', kind: 'training', ...who(a), value: snap.median_time_to_first_edit_ms,
          title: `${a.name} spends a long time before the first edit`,
          detail: `Median time to first edit is ${duration(snap.median_time_to_first_edit_ms)} over ${snap.sessions_with_edits} sessions. Pointing the assistant at the target file cuts the exploration.`,
          action: 'Name the file or function in the prompt, and keep CLAUDE.md describing where things live.',
          evidence: [table(`Time to first edit (${window})`, ['Measure', a.name], [['Sessions with edits', String(snap.sessions_with_edits)], ['Median time to first edit', duration(snap.median_time_to_first_edit_ms)]])],
        })
      }
      if (snap.reworked_files.files_in_3plus_sessions >= 1) {
        add({
          id: 'file-churn', severity: 'info', kind: 'training', ...who(a), value: snap.reworked_files.files_in_3plus_sessions,
          title: `${a.name} keeps reworking the same files`,
          detail: `${snap.reworked_files.files_in_3plus_sessions} file${snap.reworked_files.files_in_3plus_sessions === 1 ? ' was' : 's were'} edited in 3 or more sessions; the busiest in ${snap.reworked_files.max_sessions} sessions (${snap.reworked_files.max_edits} edits). A focused pass may cost less than the repeated churn.`,
          action: 'Ask which files these are (names are not sent to the server). Repeated rework usually means the task was not fully specified, or a refactor is overdue.',
          evidence: [table(`Rework (${window})`, ['Measure', a.name], [
            ['Files edited in 3+ sessions', String(snap.reworked_files.files_in_3plus_sessions)],
            ['Most sessions on one file', String(snap.reworked_files.max_sessions)],
            ['Most edits to one file', String(snap.reworked_files.max_edits)],
          ])],
        })
      }
    }
  }

  // People with usage who have not shared coaching stats (only when this server accepts them).
  if (opts.includeCoaching && !f.project) {
    const missing = aggs.filter(a => !snapshots.has(a.id)).sort((x, y) => y.cost - x.cost)
    if (missing.length) {
      add({
        id: 'coaching-not-shared', severity: 'info', kind: 'setup', value: missing.length,
        title: `${missing.length} ${missing.length === 1 ? 'person has' : 'people have'} not shared coaching stats`,
        detail: 'Corrections, time to first edit and file rework come only from clients with coaching sharing on, so these people are missing from those insights.',
        action: 'Ask them to run `codeburn sync coaching on` and accept the new consent prompt.',
        evidence: [table('Not sharing', ['Person', 'Team', 'Spend'], missing.slice(0, 15).map(a => [a.name, a.team || '-', usd(a.cost)]))],
      })
    }
  }

  // Warnings first, otherwise in the order the rules ran.
  const order = (i: Insight) => (i.severity === 'warn' ? 0 : 1)
  insights.sort((x, y) => order(x) - order(y))
  return { insights, aggs, snapshots, medians }
}

export async function computeInsights(store: Store, f: Filters, opts: { includeFindings: boolean; includeCoaching?: boolean }) {
  const { insights } = await analyse(store, f, { includeCoaching: opts.includeCoaching === true })
  const out: { insights: Insight[]; findings?: Finding[] } = { insights }
  if (opts.includeFindings) out.findings = await aggregateFindings(store, f)
  return out
}

export interface CoachingRow {
  person_id: string
  name: string
  team: string
  cost: number
  edit_turns: number
  one_shot_rate: number | null
  retries_per_edit: number | null
  plan_share: number | null
  interrupted_rate: number | null
  cache_ratio: number | null
  premium_simple_share: number | null
  tool_error_rate: number | null
  /** Null until the person shares coaching stats. */
  corrections_rate: number | null
  median_time_to_first_edit_ms: number | null
  reworked_files: number | null
  /** Ids of the insights raised for this person. */
  flags: string[]
}

/** One row per person with their measures next to the team medians, the people with the most flags first. */
export async function coachingOverview(store: Store, f: Filters, opts: { includeCoaching: boolean }) {
  const { insights, aggs, snapshots, medians } = await analyse(store, f, opts)
  const flags = new Map<string, string[]>()
  for (const i of insights) {
    if (!i.person_id || i.kind === 'setup') continue
    flags.set(i.person_id, [...(flags.get(i.person_id) ?? []), i.id])
  }
  const rows: CoachingRow[] = aggs.map(a => {
    const s = snapshots.get(a.id)?.snap
    return {
      person_id: a.id, name: a.name, team: a.team, cost: a.cost, edit_turns: a.edit_turns,
      one_shot_rate: rate(a.one_shot, a.edit_turns),
      retries_per_edit: rate(a.retries, a.edit_turns),
      plan_share: rate(a.plan_calls, a.calls),
      interrupted_rate: rate(a.interrupted, a.calls),
      cache_ratio: a.cost >= MIN_SPEND_FOR_CACHE_RULE ? cacheReadRatio({ input: a.input, cache_read: a.cache_read }) : null,
      premium_simple_share: rate(a.simplePremium, a.simpleTotal),
      tool_error_rate: rate(a.tool_errors, a.calls),
      corrections_rate: s ? rate(s.corrections, s.user_turns) : null,
      median_time_to_first_edit_ms: s ? s.median_time_to_first_edit_ms : null,
      reworked_files: s ? s.reworked_files.files_in_3plus_sessions : null,
      flags: flags.get(a.id) ?? [],
    }
  }).sort((x, y) => y.flags.length - x.flags.length || y.cost - x.cost)
  return { rows, medians, coaching_enabled: opts.includeCoaching }
}

/** Groups optimize findings by id across people; savings are summed per person-snapshot. */
export async function aggregateFindings(store: Store, f: Filters): Promise<Finding[]> {
  const params: unknown[] = []
  let sql = 'SELECT fi.person_id AS person_id, p.name AS name, fi.json AS json FROM findings fi JOIN people p ON p.id = fi.person_id WHERE 1 = 1'
  if (f.person) { sql += ' AND fi.person_id = ?'; params.push(f.person) }
  if (f.team) { sql += ' AND p.team = ?'; params.push(f.team) }
  const rows = await store.all(sql, params)
  const groups = new Map<string, { title: string; people: Map<string, string>; savings: number }>()
  for (const r of rows) {
    let doc: { findings?: Array<{ id?: string; title?: string; estimatedSavingsUSD?: number }> }
    try { doc = JSON.parse(String(r.json)) } catch { continue }
    for (const item of Array.isArray(doc.findings) ? doc.findings : []) {
      const title = typeof item.title === 'string' ? item.title : null
      const key = typeof item.id === 'string' ? item.id : title
      if (!key || !title) continue
      const g = groups.get(key) ?? { title, people: new Map<string, string>(), savings: 0 }
      g.people.set(r.person_id, String(r.name))
      g.savings += Number.isFinite(item.estimatedSavingsUSD) ? Number(item.estimatedSavingsUSD) : 0
      groups.set(key, g)
    }
  }
  return [...groups.values()]
    .map(g => ({ title: g.title, people: g.people.size, names: [...g.people.values()].sort().slice(0, 20), estimated_savings_usd: g.savings }))
    .sort((a, b) => b.people - a.people || b.estimated_savings_usd - a.estimated_savings_usd)
    .slice(0, 20)
}
