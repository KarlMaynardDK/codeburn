import { afterEach, describe, expect, it } from 'vitest'

import { b, BACKENDS, arr, daysAgo, dayStr, enrollPerson, i, post, send, span, startServer, viewerClient, type TestServer } from './helpers.js'

type Who = Awaited<ReturnType<typeof enrollPerson>>

/** A first call of a prompt that edited files; `retries` > 0 means it was not a one-shot. */
const turn = (id: string, o: { retries?: number; category?: string; at?: number; extra?: ReturnType<typeof i>[] } = {}) =>
  span({ id, cost: 0.1, category: o.category ?? 'coding', at: o.at ?? daysAgo(1), input: 100, cacheRead: 900,
    attrs: [b('ai.turn_start', true), b('ai.turn_has_edits', true), i('ai.turn_retries', o.retries ?? 0), ...(o.extra ?? [])] })

const range = `from=${dayStr(daysAgo(12))}&to=${dayStr(daysAgo(0))}`

describe.each(BACKENDS)('team insights (%s)', backend => {
  let t: TestServer
  afterEach(async () => { await t?.cleanup() })

  const insightsFor = async (path = `/api/team/insights?${range}`) => {
    const v = await viewerClient(t)
    return (await v.get(path)).json.insights as any[]
  }
  const by = (list: any[], id: string) => list.filter(x => x.id === id)
  const people = (names: string[]) => Promise.all(names.map(nm => enrollPerson(t, nm)))
  /** `count` turns for a person, `slow` of which needed a retry. */
  const turns = (p: Who, tag: string, count: number, slow: number, category = 'coding') =>
    send(t, p.cred, Array.from({ length: count }, (_, k) => turn(`${tag}${k}`, { retries: k < slow ? 1 : 0, category })))

  describe('peer comparison with small teams', () => {
    it('compares two people, and nobody against themselves', async () => {
      t = await startServer(backend)
      const [a, bb] = await people(['A', 'B'])
      await send(t, a!.cred, [span({ id: 'a1', at: daysAgo(1), cost: 2, input: 100, cacheRead: 900 })])
      await send(t, bb!.cred, [span({ id: 'b1', at: daysAgo(1), cost: 2, input: 1000, cacheRead: 0 })])
      const list = await insightsFor()
      expect(by(list, 'low-cache-read').map(x => x.person)).toEqual(['B'])
      await t.cleanup()

      t = await startServer(backend)
      const [solo] = await people(['Solo'])
      await send(t, solo!.cred, [span({ id: 's1', at: daysAgo(1), cost: 2, input: 1000, cacheRead: 0 })])
      expect(by(await insightsFor(), 'low-cache-read')).toEqual([])
    })
  })

  describe('evidence', () => {
    it('shows which models, task types and projects behind premium-on-simple, with an action and a person link', async () => {
      t = await startServer(backend)
      const [p] = await people(['Pat'])
      await send(t, p!.cred, [
        span({ id: 'e1', at: daysAgo(1), cost: 20, model: 'claude-opus-4', category: 'conversation', project: 'docs' }),
        span({ id: 'e2', at: daysAgo(1), cost: 5, model: 'claude-opus-4', category: 'exploration', project: 'api' }),
        span({ id: 'e3', at: daysAgo(1), cost: 1, model: 'claude-haiku-4', category: 'general', project: 'api' }),
      ])
      const [ins] = by(await insightsFor(), 'premium-on-simple')
      expect(ins).toMatchObject({ person: 'Pat', person_id: p!.person.id, kind: 'training', severity: 'warn' })
      expect(ins.detail).toContain('claude-opus-4')
      expect(typeof ins.action).toBe('string')
      const [models, projects] = ins.evidence
      expect(models.rows[0]).toEqual(['claude-opus-4', 'Conversation', '$20.00', '77%'])
      expect(models.rows[1]).toEqual(['claude-opus-4', 'Exploration', '$5.00', '19%'])
      expect(projects.rows).toEqual([['docs', '$20.00'], ['api', '$5.00']])
    })

    it('breaks a spend spike down by project and model', async () => {
      t = await startServer(backend)
      const [p] = await people(['Sam'])
      await send(t, p!.cred, [
        span({ id: 'p1', at: daysAgo(9), cost: 1, project: 'old', model: 'claude-sonnet-4' }),
        span({ id: 'c1', at: daysAgo(1), cost: 30, project: 'migration', model: 'claude-opus-4' }),
        span({ id: 'c2', at: daysAgo(1), cost: 2, project: 'old', model: 'claude-sonnet-4' }),
      ])
      const [ins] = by(await insightsFor(), 'spend-spike')
      expect(ins.kind).toBe('cost')
      expect(ins.evidence[0].rows[0]).toEqual(['migration', 'claude-opus-4', '$30.00', '$0.00'])
    })
  })

  describe('training rules', () => {
    it('flags a low one-shot rate with a task-type breakdown, and no plan mode', async () => {
      t = await startServer(backend)
      const [a, b1, c] = await people(['Ann', 'Ben', 'Cy'])
      await turns(a!, 'a', 10, 7)
      await turns(b1!, 'b', 10, 1)
      await turns(c!, 'c', 10, 1)
      const list = await insightsFor()
      const [ins] = by(list, 'low-one-shot')
      expect(ins).toMatchObject({ person: 'Ann', kind: 'training' })
      expect(ins.value).toBeCloseTo(0.3)
      expect(ins.evidence[0].rows).toContainEqual(['One-shot rate', '30%', '90%'])
      expect(ins.evidence[0].rows).toContainEqual(['Retries per edit prompt', '0.70', '0.10'])
      expect(ins.evidence[1].rows[0]).toEqual(['Coding', '10', '30%', '90%'])
      expect(by(list, 'no-plan-mode').map(x => x.person)).toEqual(['Ann'])
      // The relative rule already covers Ann, so the task-type rule stays quiet for her.
      expect(by(list, 'weak-task-type')).toEqual([])
    })

    it('flags a weak task type for one person alone', async () => {
      t = await startServer(backend)
      const [p] = await people(['Dee'])
      await turns(p!, 'd', 6, 4, 'debugging')
      const [ins] = by(await insightsFor(), 'weak-task-type')
      expect(ins).toMatchObject({ person: 'Dee', kind: 'training' })
      expect(ins.title).toContain('debugging')
      expect(ins.detail).toContain('33%')
      expect(ins.evidence[0].rows).toEqual([['Debugging', '6', '33%', '-']])
    })

    it('does not suggest plan mode to someone who uses it', async () => {
      t = await startServer(backend)
      const [p] = await people(['Eli'])
      await send(t, p!.cred, Array.from({ length: 10 }, (_, k) => turn(`e${k}`, { retries: 1, extra: [b('ai.plan_mode', true) as any] })))
      expect(by(await insightsFor(), 'no-plan-mode')).toEqual([])
    })

    it('flags frequent interruptions and tool errors with the MCP tools in use', async () => {
      t = await startServer(backend)
      const [a, b1, c] = await people(['Fay', 'Gus', 'Hal'])
      const calls = (tag: string, interrupted: number, errors: number, mcp = false) =>
        Array.from({ length: 60 }, (_, k) => span({
          id: `${tag}${k}`, at: daysAgo(1), cost: 0.1,
          attrs: [
            ...(k < interrupted ? [b('ai.interrupted', true)] : []),
            ...(k < errors ? [i('ai.tool_errors', 1)] : []),
            ...(mcp && k < 10 ? [arr('ai.mcp_tools', ['mcp__github__get_issue'])] : []),
          ],
        }))
      await send(t, a!.cred, calls('f', 12, 6, true))
      await send(t, b1!.cred, calls('g', 1, 0))
      await send(t, c!.cred, calls('h', 1, 0))
      const list = await insightsFor()
      const [intr] = by(list, 'frequent-interrupts')
      expect(intr).toMatchObject({ person: 'Fay', kind: 'training' })
      expect(intr.evidence[0].rows).toContainEqual(['Share interrupted', '20.0%', '1.7%'])
      const [err] = by(list, 'tool-errors')
      expect(err).toMatchObject({ person: 'Fay', kind: 'setup' })
      expect(err.evidence[1].rows).toEqual([['mcp__github__get_issue', '10']])
    })

    it('flags mid-session model switches by the model switched to, and stays quiet below the threshold', async () => {
      t = await startServer(backend)
      const [a, b1] = await people(['Ivy', 'Jon'])
      const switches = (tag: string, n: number, tokens: number, model: string) =>
        Array.from({ length: n }, (_, k) => span({ id: `${tag}${k}`, at: daysAgo(1), model, attrs: [i('ai.model_switch_tokens', tokens)] }))
      await send(t, a!.cred, [...switches('o', 3, 90_000, 'claude-opus-4-1'), ...switches('s', 1, 30_000, 'claude-sonnet-4')])
      await send(t, b1!.cred, switches('j', 2, 150_000, 'claude-opus-4-1'))
      const list = by(await insightsFor(), 'model-switch-recache')
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ person: 'Ivy', kind: 'training', severity: 'info', value: 300_000 })
      expect(list[0].detail).toContain('4 switches re-sent 300.0K tokens')
      expect(list[0].evidence[0].rows).toEqual([['claude-opus-4-1', '3', '270.0K'], ['claude-sonnet-4', '1', '30.0K']])
    })

    it('names the people using fast mode', async () => {
      t = await startServer(backend)
      const [a, b1] = await people(['Ivy', 'Jon'])
      await send(t, a!.cred, [span({ id: 'i1', at: daysAgo(1), cost: 8, speed: 'fast' })])
      await send(t, b1!.cred, [span({ id: 'j1', at: daysAgo(1), cost: 2 })])
      const [ins] = by(await insightsFor(), 'fast-mode-share')
      expect(ins.evidence[0].rows).toEqual([['Ivy', '$8.00', '100%']])
    })
  })

  describe('coaching snapshots', () => {
    const snap = (over: Record<string, unknown> = {}) => ({
      captured_at: new Date().toISOString(),
      coaching: {
        period: { label: 'Last 30 days', start: '2026-10-01', end: '2026-10-30' },
        user_turns: 40, corrections: 10, sessions_with_edits: 6, median_time_to_first_edit_ms: 8 * 60_000,
        reworked_files: { files_in_3plus_sessions: 2, max_sessions: 5, max_edits: 17 },
        ...over,
      },
    })
    const auth = (w: Who) => ({ authorization: `Bearer ${w.cred}` })

    it('is off unless the server accepts it, and is advertised when it does', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      let doc = await (await fetch(`${t.base}/.well-known/codeburn-export.json`)).json() as any
      expect(doc.coaching_path).toBeUndefined()
      expect(await post(t.base, '/v1/coaching', snap(), auth(a))).toMatchObject({ status: 404, json: { error: 'coaching_disabled' } })
      await t.cleanup()
      t = await startServer(backend, { accept_coaching: true })
      doc = await (await fetch(`${t.base}/.well-known/codeburn-export.json`)).json()
      expect(doc.coaching_path).toBe('/v1/coaching')
    })

    it('needs a device credential and an object body', async () => {
      t = await startServer(backend, { accept_coaching: true })
      const a = await enrollPerson(t, 'Ann')
      expect((await post(t.base, '/v1/coaching', snap())).status).toBe(401)
      expect((await post(t.base, '/v1/coaching', { captured_at: 'x' }, auth(a))).json).toEqual({ error: 'coaching_required' })
      expect((await post(t.base, '/v1/coaching', { coaching: [] }, auth(a))).json).toEqual({ error: 'coaching_required' })
      expect((await post(t.base, '/v1/coaching', '{', auth(a))).json).toEqual({ error: 'malformed_json' })
    })

    it('stores only allow-listed numbers, clamped, and keeps the latest per person', async () => {
      t = await startServer(backend, { accept_coaching: true })
      const a = await enrollPerson(t, 'Ann')
      const hostile = snap({
        user_turns: 10, corrections: 99, secret: 'C:\\Users\\ann\\notes.txt', median_time_to_first_edit_ms: -5,
        period: { label: '/home/ann/x\n', start: 5, end: null, path: '/etc/passwd' },
        reworked_files: { files_in_3plus_sessions: 'many', max_sessions: -1, max_edits: 4.9, names: ['a.ts'] },
      })
      expect((await post(t.base, '/v1/coaching', hostile, auth(a))).json).toEqual({ ok: true })
      const [row] = await t.store.all('SELECT json FROM coaching WHERE person_id = ?', [a.person.id])
      const stored = JSON.parse(row!.json)
      expect(stored).toEqual({
        period: { label: '/home/ann/x', start: null, end: null },
        user_turns: 10, corrections: 10, sessions_with_edits: 6, median_time_to_first_edit_ms: null,
        reworked_files: { files_in_3plus_sessions: 0, max_sessions: 0, max_edits: 4 },
      })
      await post(t.base, '/v1/coaching', snap({ user_turns: 50 }), auth(a))
      expect((await t.store.all('SELECT COUNT(*) AS n FROM coaching'))[0]!.n).toBe(1)
      expect(JSON.parse((await t.store.all('SELECT json FROM coaching'))[0]!.json).user_turns).toBe(50)
    })

    it('raises corrections, slow first edit and rework, and lists who has not shared', async () => {
      t = await startServer(backend, { accept_coaching: true })
      const [a, b1] = await people(['Kai', 'Liv'])
      await send(t, a!.cred, [span({ id: 'k1', at: daysAgo(1) })])
      await send(t, b1!.cred, [span({ id: 'l1', at: daysAgo(1) })])
      await post(t.base, '/v1/coaching', snap(), auth(a!))
      const list = await insightsFor()
      const [corr] = by(list, 'frequent-corrections')
      expect(corr).toMatchObject({ person: 'Kai', person_id: a!.person.id, kind: 'training', severity: 'warn' })
      expect(corr.detail).toContain('25%')
      expect(corr.evidence[0].rows).toContainEqual(['Corrections', '10'])
      expect(corr.evidence[0].title).toContain('Last 30 days')
      expect(by(list, 'slow-first-edit')[0].detail).toContain('8 min')
      const [churn] = by(list, 'file-churn')
      expect(churn.detail).toContain('2 files were edited in 3 or more sessions')
      expect(JSON.stringify(churn)).not.toMatch(/\.ts|\/|\\/)
      const [missing] = by(list, 'coaching-not-shared')
      expect(missing.kind).toBe('setup')
      expect(missing.evidence[0].rows.map((r: string[]) => r[0])).toEqual(['Liv'])
    })

    it('stays quiet about healthy numbers, and about coaching when the server does not accept it', async () => {
      t = await startServer(backend, { accept_coaching: true })
      const a = await enrollPerson(t, 'Mia')
      await send(t, a.cred, [span({ id: 'm1', at: daysAgo(1) })])
      await post(t.base, '/v1/coaching', snap({ corrections: 1, median_time_to_first_edit_ms: 30_000, reworked_files: { files_in_3plus_sessions: 0, max_sessions: 2, max_edits: 3 } }), auth(a))
      expect(await insightsFor()).toEqual([])
      await post(t.base, '/v1/coaching', snap(), auth(a))
      t.config.accept_coaching = false
      expect(await insightsFor()).toEqual([])
    })

    it('carries a snapshot along on merge and removes it on delete', async () => {
      t = await startServer(backend)
      const ts = t
      {
        const a = (await ts.store.addPerson({ name: 'A', email: '', team: 'T' })).person
        const c = (await ts.store.addPerson({ name: 'C', email: '', team: 'T' })).person
        const d = (await ts.store.addPerson({ name: 'D', email: '', team: 'T' })).person
        await ts.store.saveCoaching(a.id, '2026-10-30T00:00:00.000Z', '{"user_turns":3}')
        await ts.store.saveCoaching(d.id, '2026-10-31T00:00:00.000Z', '{"user_turns":9}')
        await ts.store.mergePerson(a.id, c.id)
        await ts.store.mergePerson(d.id, c.id)
        const rows = await ts.store.all('SELECT person_id, json FROM coaching')
        // The target keeps its own row when it has one; here it had none, so it takes the first and keeps it.
        expect(rows).toEqual([{ person_id: c.id, json: '{"user_turns":3}' }])
        await ts.store.deletePerson(c.id, true)
        expect(await ts.store.all('SELECT * FROM coaching')).toEqual([])
      }
    })
  })

  describe('coaching overview and findings', () => {
    it('lists each person against the team medians, most flags first', async () => {
      t = await startServer(backend)
      const [a, b1, c] = await people(['Ann', 'Ben', 'Cy'])
      await turns(a!, 'a', 10, 7)
      await turns(b1!, 'b', 10, 1)
      await turns(c!, 'c', 10, 1)
      const v = await viewerClient(t)
      const r = (await v.get(`/api/team/coaching?${range}`)).json
      expect(r.coaching_enabled).toBe(false)
      expect(r.rows.map((x: any) => x.name)[0]).toBe('Ann')
      expect(r.rows[0]).toMatchObject({ person_id: a!.person.id, edit_turns: 10, corrections_rate: null })
      expect(r.rows[0].one_shot_rate).toBeCloseTo(0.3)
      expect(r.rows[0].flags).toEqual(expect.arrayContaining(['low-one-shot', 'no-plan-mode']))
      expect(r.rows[1].flags).toEqual([])
      expect(r.medians.one_shot_rate).toBeCloseTo(0.9)
      expect((await fetch(`${t.base}/api/team/coaching`)).status).toBe(401)
    })

    it('names the people behind each optimize finding', async () => {
      t = await startServer(backend, { accept_findings: true })
      const [a, b1] = await people(['Ann', 'Bob'])
      const doc = { findings: [{ id: 'cache-miss', title: 'Cache misses', estimatedSavingsUSD: 3 }] }
      for (const w of [a!, b1!]) await post(t.base, '/v1/findings', { captured_at: new Date().toISOString(), findings: doc }, { authorization: `Bearer ${w.cred}` })
      const v = await viewerClient(t)
      const f = (await v.get('/api/team/insights')).json.findings.find((x: any) => x.title === 'Cache misses')
      expect(f).toMatchObject({ people: 2, names: ['Ann', 'Bob'], estimated_savings_usd: 6 })
    })
  })
})
