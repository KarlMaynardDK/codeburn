import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKENDS, daysAgo, dayStr, enrollPerson, hoursAgo, payload, post, send, span, startServer, viewerClient, type TestServer } from './helpers.js'

describe.each(BACKENDS)('team server (%s)', backend => {
  let t: TestServer
  afterEach(async () => { await t?.cleanup() })

  describe('discovery and enrollment', () => {
    it('advertises enrollment auth and gates detail levels and findings on config', async () => {
      t = await startServer(backend, { org_name: 'Acme' })
      let doc = await (await fetch(`${t.base}/.well-known/codeburn-export.json`)).json() as any
      expect(doc).toMatchObject({ version: 1, auth: 'enrollment', enroll_path: '/v1/enroll', traces_path: '/v1/traces', max_batch_size: 1000, detail_levels: ['summary'], org_name: 'Acme' })
      expect(doc.findings_path).toBeUndefined()
      expect(doc.issuer).toBeUndefined()
      await t.cleanup()
      t = await startServer(backend, { accept_session_detail: true, accept_findings: true })
      doc = await (await fetch(`${t.base}/.well-known/codeburn-export.json`)).json()
      expect(doc.detail_levels).toEqual(['summary', 'sessions'])
      expect(doc.findings_path).toBe('/v1/findings')
    })

    it('enrollment token is single use and yields a working credential', async () => {
      t = await startServer(backend)
      const { person, enrollmentToken } = await t.store.addPerson({ name: 'Ann', email: 'ann@example.com', team: 'core' })
      const ok = await post(t.base, '/v1/enroll', { token: enrollmentToken, label: 'laptop', device_id: 'abc' })
      expect(ok.status).toBe(200)
      expect(ok.json.credential).toMatch(/^cbd_/)
      expect(ok.json.person).toEqual({ name: 'Ann', email: 'ann@example.com' })
      const again = await post(t.base, '/v1/enroll', { token: enrollmentToken })
      expect(again.status).toBe(401)
      expect(again.json).toEqual({ error: 'invalid_or_expired_token' })
      expect((await send(t, ok.json.credential, [span({ id: 's1' })])).status).toBe(200)
      // One person can enroll several devices.
      const next = await t.store.rotateEnrollment(person.id)
      expect((await post(t.base, '/v1/enroll', { token: next })).status).toBe(200)
      expect((await t.store.listPeople())[0]!.devices).toHaveLength(2)
    })

    it('rejects expired, unknown and rotated-away tokens', async () => {
      t = await startServer(backend)
      const { person, enrollmentToken: expired } = await t.store.addPerson({ name: 'Ann', email: '', team: '' }, -1000)
      expect((await post(t.base, '/v1/enroll', { token: expired })).status).toBe(401)
      expect((await post(t.base, '/v1/enroll', { token: 'cbe_nope' })).status).toBe(401)
      const old = await t.store.rotateEnrollment(person.id)
      const fresh = await t.store.rotateEnrollment(person.id)
      expect((await post(t.base, '/v1/enroll', { token: old })).status).toBe(401)
      expect((await post(t.base, '/v1/enroll', { token: fresh })).status).toBe(200)
    })

    it('revoking a person or a device makes /v1/traces return 401', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const b = await enrollPerson(t, 'Bob')
      expect((await send(t, a.cred, [span({ id: 'a1' })])).status).toBe(200)
      expect(await t.store.revoke(a.deviceId)).toBe('device')
      expect((await send(t, a.cred, [span({ id: 'a2' })])).status).toBe(401)
      expect((await send(t, b.cred, [span({ id: 'b1' })])).status).toBe(200)
      expect(await t.store.revoke(b.person.id)).toBe('person')
      expect((await send(t, b.cred, [span({ id: 'b2' })])).status).toBe(401)
      // Revoked people cannot enroll with an outstanding token either.
      const c = await t.store.addPerson({ name: 'Cy', email: '', team: '' })
      await t.store.revoke(c.person.id)
      expect((await post(t.base, '/v1/enroll', { token: c.enrollmentToken })).status).toBe(401)
      expect(await t.store.revoke('nope')).toBeNull()
    })
  })

  describe('traces ingest', () => {
    it('requires a bearer credential, valid JSON, and honours the batch cap', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      expect((await post(t.base, '/v1/traces', payload([span({ id: 'x' })]))).status).toBe(401)
      expect((await post(t.base, '/v1/traces', payload([]), { authorization: 'Bearer cbd_bogus' })).status).toBe(401)
      expect((await post(t.base, '/v1/traces', '{not json', { authorization: `Bearer ${a.cred}` })).status).toBe(400)
      const big = Array.from({ length: 1001 }, (_, n) => span({ id: `big${n}` }))
      expect((await send(t, a.cred, big)).status).toBe(413)
      const ok = await send(t, a.cred, [span({ id: 'ok' })])
      expect(ok.json).toEqual({ partialSuccess: {} })
    })

    it('is idempotent: re-sending identical spans leaves daily_usage unchanged', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const spans = [
        span({ id: 's1', cost: 1.25, input: 10, output: 20, cacheRead: 5, cacheWrite: 3, category: 'coding' }),
        span({ id: 's2', cost: 0.75, input: 1, output: 2, category: 'coding' }),
        span({ id: 's3', cost: 2, category: 'debugging', model: 'claude-opus-4' }),
      ]
      await send(t, a.cred, spans)
      const snapshot = async () => t.store.all('SELECT * FROM daily_usage ORDER BY day, provider, model, project, category')
      const first = await snapshot()
      expect(first).toHaveLength(2)
      expect(first.find(r => r.category === 'coding')).toMatchObject({ input: 11, output: 22, cache_read: 5, cache_write: 3, calls: 2, cost_usd: 2 })
      await send(t, a.cred, spans)
      await send(t, a.cred, [spans[0]!])
      expect(await snapshot()).toEqual(first)
      expect((await t.store.all('SELECT COUNT(*) AS n FROM spans'))[0]!.n).toBe(3)
    })

    it('an updated span moves between days without leaving stale rollup rows', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      await send(t, a.cred, [span({ id: 'm', at: daysAgo(3), cost: 1 })])
      await send(t, a.cred, [span({ id: 'm', at: daysAgo(1), cost: 4 })])
      const rows = await t.store.all('SELECT day, cost_usd FROM daily_usage')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ day: dayStr(daysAgo(1)), cost_usd: 4 })
    })

    it('never reassigns a span id to a different person', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const b = await enrollPerson(t, 'Bob')
      await send(t, a.cred, [span({ id: 'shared', cost: 1 })])
      const r = await send(t, b.cred, [span({ id: 'shared', cost: 99 })])
      expect(r.json.partialSuccess.rejectedSpans).toBe(1)
      const rows = await t.store.all('SELECT person_id, cost_usd FROM spans WHERE span_id = ?', ['shared'])
      expect(rows).toEqual([{ person_id: a.person.id, cost_usd: 1 }])
    })

    it('identity comes from the credential, not the payload', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      await send(t, a.cred, [span({ id: 's1' })])
      const rows = await t.store.all('SELECT person_id, device_id FROM spans')
      expect(rows).toEqual([{ person_id: a.person.id, device_id: a.deviceId }])
    })

    it('rejects spans older than 183 days or far in the future, ignores spans without ai.provider, defaults category', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const gitSpan = { traceId: 'b'.repeat(32), spanId: 'git1', name: 'codeburn.commit', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: [{ key: 'git.sha', value: { stringValue: 'abc' } }] }
      const r = await send(t, a.cred, [
        span({ id: 'old', at: hoursAgo(184 * 24) }),
        span({ id: 'fut', at: hoursAgo(-72) }),
        span({ id: 'fine', at: hoursAgo(170 * 24), category: null }),
        gitSpan,
      ])
      expect(r.status).toBe(200)
      expect(r.json.partialSuccess.rejectedSpans).toBe(2)
      const rows = await t.store.all('SELECT span_id, category FROM spans')
      expect(rows).toEqual([{ span_id: 'fine', category: 'unknown' }])
    })

    it('updates devices.last_seen', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      await t.store.all("UPDATE devices SET last_seen = '2020-01-01T00:00:00.000Z'")
      await send(t, a.cred, [span({ id: 's1' })])
      const [row] = await t.store.all('SELECT last_seen FROM devices')
      expect(row!.last_seen > '2020-01-01').toBe(true)
    })
  })

  describe('session detail gating', () => {
    it('accept_session_detail=false: a sessions-level payload stores no session rows or session attrs', async () => {
      t = await startServer(backend, { accept_session_detail: false })
      const a = await enrollPerson(t, 'Ann')
      await send(t, a.cred, [span({ id: 's1', session: true }), span({ id: 's2', session: true })], 'sessions')
      expect((await t.store.all('SELECT COUNT(*) AS n FROM sessions'))[0]!.n).toBe(0)
      const spans = await t.store.all('SELECT work_unit_id, session_role, call_count, session_duration_ms FROM spans')
      expect(spans).toHaveLength(2)
      for (const s of spans) expect(s).toEqual({ work_unit_id: null, session_role: null, call_count: null, session_duration_ms: null })
      expect((await t.store.all('SELECT SUM(calls) AS n FROM daily_usage'))[0]!.n).toBe(2)
      const viewer = await viewerClient(t)
      expect((await viewer.get('/api/team/sessions')).json).toEqual({ error: 'sessions_disabled' })
    })

    it('accept_session_detail=true stores sessions only for sessions-level batches', async () => {
      t = await startServer(backend, { accept_session_detail: true })
      const a = await enrollPerson(t, 'Ann')
      await send(t, a.cred, [span({ id: 's1', trace: 't1'.padEnd(32, '0'), session: true }), span({ id: 's2', trace: 't1'.padEnd(32, '0'), session: true }), span({ id: 's3', trace: 't2'.padEnd(32, '0'), session: true, cost: 3 })], 'sessions')
      await send(t, a.cred, [span({ id: 's4', trace: 't3'.padEnd(32, '0'), session: true })], 'summary')
      const sessions = await t.store.all('SELECT trace_id, calls, cost, duration_ms FROM sessions ORDER BY trace_id')
      expect(sessions).toEqual([
        { trace_id: 't1'.padEnd(32, '0'), calls: 2, cost: 1, duration_ms: 90000 },
        { trace_id: 't2'.padEnd(32, '0'), calls: 1, cost: 3, duration_ms: 90000 },
      ])
      // Summary-level spans never carry session attrs even if a client sent them.
      expect((await t.store.all("SELECT work_unit_id FROM spans WHERE span_id = 's4'"))[0]!.work_unit_id).toBeNull()
      const viewer = await viewerClient(t)
      const api = await viewer.get('/api/team/sessions')
      expect(api.status).toBe(200)
      expect(api.json.sessions).toHaveLength(2)
      expect(api.json.sessions[0]).toMatchObject({ person: 'Ann', project: 'app' })
    })

    it('a missing detail level is treated as sessions but still stripped when the server refuses detail', async () => {
      t = await startServer(backend, { accept_session_detail: false })
      const a = await enrollPerson(t, 'Ann')
      await send(t, a.cred, [span({ id: 's1', session: true })], null)
      expect((await t.store.all('SELECT work_unit_id, detail_level FROM spans'))[0]).toEqual({ work_unit_id: null, detail_level: 'sessions' })
    })
  })

  describe('findings', () => {
    it('is 404 when disabled and stores the latest snapshot per person when enabled', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const auth = { authorization: `Bearer ${a.cred}` }
      expect((await post(t.base, '/v1/findings', { findings: {} }, auth)).status).toBe(404)
      await t.cleanup()

      t = await startServer(backend, { accept_findings: true })
      const b = await enrollPerson(t, 'Bob')
      const c = await enrollPerson(t, 'Cy')
      const h = (cred: string) => ({ authorization: `Bearer ${cred}` })
      expect((await post(t.base, '/v1/findings', { findings: {} })).status).toBe(401)
      expect((await post(t.base, '/v1/findings', { captured_at: new Date().toISOString() }, h(b.cred))).status).toBe(400)
      const mk = (savings: number) => ({ findings: [{ id: 'cache-miss', title: 'Cache misses', estimatedSavingsUSD: savings }, { id: 'big-ctx', title: 'Huge contexts', estimatedSavingsUSD: 1 }] })
      expect((await post(t.base, '/v1/findings', { captured_at: new Date().toISOString(), findings: mk(100) }, h(b.cred))).json).toEqual({ ok: true })
      await post(t.base, '/v1/findings', { captured_at: new Date().toISOString(), findings: mk(10) }, h(b.cred))
      await post(t.base, '/v1/findings', { captured_at: new Date().toISOString(), findings: { findings: [{ id: 'cache-miss', title: 'Cache misses', estimatedSavingsUSD: 5 }] } }, h(c.cred))
      expect((await t.store.all('SELECT COUNT(*) AS n FROM findings'))[0]!.n).toBe(2)
      const viewer = await viewerClient(t)
      const ins = (await viewer.get('/api/team/insights')).json
      // Bob's second snapshot replaced his first (10, not 110); Cy adds 5.
      expect(Array.isArray(ins.findings)).toBe(true)
      const cm = ins.findings.find((f: any) => f.title === 'Cache misses')
      expect(cm).toMatchObject({ people: 2, estimated_savings_usd: 15 })
    })
  })

  describe('viewer API', () => {
    it('rejects unauthenticated requests and bad keys', async () => {
      t = await startServer(backend)
      for (const p of ['meta', 'overview', 'people', 'models', 'projects', 'sessions', 'insights', 'people/x']) {
        const r = await fetch(`${t.base}/api/team/${p}`)
        expect(r.status).toBe(401)
        expect(await r.json()).toEqual({ error: 'unauthenticated' })
      }
      const bad = await post(t.base, '/api/team/login', { key: 'cbv_wrong' }, { origin: `http://${t.host}` })
      expect(bad.status).toBe(401)
      const forged = await fetch(`${t.base}/api/team/meta`, { headers: { cookie: 'cb_team_session=cbs_forged' } })
      expect(forged.status).toBe(401)
    })

    it('login sets an HttpOnly SameSite=Strict cookie, logout invalidates it, revoked viewer keys fail', async () => {
      t = await startServer(backend)
      const v = await viewerClient(t)
      expect(v.login.status).toBe(200)
      expect(v.login.json).toEqual({ viewer: { name: 'Boss' } })
      const setCookie = v.login.headers.get('set-cookie')!
      expect(setCookie).toMatch(/^cb_team_session=cbs_/)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Strict')
      expect(setCookie).toContain('Max-Age=43200')
      expect(setCookie).not.toContain('Secure')
      expect((await v.get('/api/team/meta')).status).toBe(200)
      const out = await post(t.base, '/api/team/logout', {}, { origin: `http://${t.host}`, cookie: v.cookie })
      expect(out.status).toBe(200)
      expect((await v.get('/api/team/meta')).status).toBe(401)
      await t.store.all('UPDATE viewers SET revoked_at = ?', [new Date().toISOString()])
      expect((await post(t.base, '/api/team/login', { key: v.key }, { origin: `http://${t.host}` })).status).toBe(401)
    })

    it('rejects cross-origin requests even with a valid session', async () => {
      t = await startServer(backend)
      const v = await viewerClient(t)
      const evil = await fetch(`${t.base}/api/team/overview`, { headers: { cookie: v.cookie, origin: 'https://evil.example' } })
      expect(evil.status).toBe(403)
      const site = await fetch(`${t.base}/api/team/overview`, { headers: { cookie: v.cookie, 'sec-fetch-site': 'cross-site' } })
      expect(site.status).toBe(403)
      const same = await fetch(`${t.base}/api/team/overview`, { headers: { cookie: v.cookie, origin: `http://${t.host}` } })
      expect(same.status).toBe(200)
      // Login needs a matching Origin too (no CSRF-able login), even with a valid key.
      expect((await post(t.base, '/api/team/login', { key: v.key })).status).toBe(403)
      expect((await post(t.base, '/api/team/login', { key: v.key }, { origin: 'https://evil.example' })).status).toBe(403)
      const logout = await post(t.base, '/api/team/logout', {}, { cookie: v.cookie, origin: 'https://evil.example' })
      expect(logout.status).toBe(403)
      expect((await v.get('/api/team/meta')).status).toBe(200)
    })

    it('aggregates match ingested data', async () => {
      t = await startServer(backend)
      const ann = await enrollPerson(t, 'Ann', 'core')
      const bob = await enrollPerson(t, 'Bob', 'web')
      await send(t, ann.cred, [
        span({ id: 'a1', at: daysAgo(2), cost: 3, input: 100, output: 10, cacheRead: 300, cacheWrite: 20, model: 'claude-opus-4', category: 'coding', project: 'alpha', provider: 'claude' }),
        span({ id: 'a2', at: daysAgo(1), cost: 1, input: 50, output: 5, model: 'claude-sonnet-4', category: 'debugging', project: 'alpha', provider: 'claude' }),
        span({ id: 'a3', at: daysAgo(1), cost: 0.5, input: 10, output: 1, model: 'gpt-4o', category: 'coding', project: 'beta', provider: 'codex' }),
      ])
      await send(t, bob.cred, [
        span({ id: 'b1', at: daysAgo(1), cost: 2, input: 40, output: 4, model: 'claude-sonnet-4', category: 'coding', project: 'alpha', provider: 'claude' }),
      ])
      const v = await viewerClient(t)
      const to = dayStr(daysAgo(0))
      const from = dayStr(daysAgo(5))

      const ov = (await v.get(`/api/team/overview?from=${from}&to=${to}`)).json
      expect(ov.totals).toMatchObject({ cost: 6.5, input: 200, output: 20, cache_read: 300, cache_write: 20, calls: 4, active_people: 2 })
      expect(ov.daily).toHaveLength(6)
      expect(ov.daily.reduce((s: number, d: any) => s + d.cost, 0)).toBeCloseTo(6.5)
      const dayRow = ov.daily.find((d: any) => d.day === dayStr(daysAgo(1)))
      expect(dayRow).toMatchObject({ cost: 3.5, calls: 3 })
      expect(ov.by_provider).toEqual([
        { name: 'claude', cost: 6, tokens: 100 + 10 + 300 + 20 + 55 + 44 },
        { name: 'codex', cost: 0.5, tokens: 11 },
      ])
      expect(ov.by_model[0]).toMatchObject({ name: 'claude-opus-4', cost: 3 })
      expect(ov.by_team).toEqual([{ name: 'core', cost: 4.5, tokens: 430 + 55 + 11 }, { name: 'web', cost: 2, tokens: 44 }])
      expect(ov.mtd.days_in_month).toBeGreaterThanOrEqual(28)
      expect(ov.compare).toBeUndefined()

      const cmp = (await v.get(`/api/team/overview?from=${dayStr(daysAgo(1))}&to=${to}&compare=previous`)).json
      expect(cmp.compare.cost).toBe(3) // the 2-day window before: only a1 (2 days ago)
      expect(cmp.totals.cost).toBe(3.5)

      const filtered = (await v.get(`/api/team/overview?from=${from}&to=${to}&team=web`)).json
      expect(filtered.totals).toMatchObject({ cost: 2, active_people: 1 })
      const byProject = (await v.get(`/api/team/overview?from=${from}&to=${to}&project=beta`)).json
      expect(byProject.totals.cost).toBe(0.5)

      const ppl = (await v.get(`/api/team/people?from=${from}&to=${to}`)).json.people
      const a = ppl.find((p: any) => p.name === 'Ann')
      expect(a).toMatchObject({ cost: 4.5, input: 160, cache_read: 300, calls: 3, team: 'core', top_model: 'claude-opus-4' })
      expect(a.cache_read_ratio).toBeCloseTo(300 / 460)
      expect(a.trend).toHaveLength(6)
      expect(a.trend.reduce((s: number, x: number) => s + x, 0)).toBeCloseTo(4.5)
      expect(a.last_seen).toBeTruthy()

      const det = (await v.get(`/api/team/people/${ann.person.id}?from=${from}&to=${to}`)).json
      expect(det.person.name).toBe('Ann')
      expect(det.by_project).toEqual([{ name: 'alpha', cost: 4, tokens: 485, calls: 2 }, { name: 'beta', cost: 0.5, tokens: 11, calls: 1 }])
      expect(det.by_category.map((c: any) => c.name).sort()).toEqual(['coding', 'debugging'])
      expect(det.by_provider).toHaveLength(2)
      expect((await v.get('/api/team/people/p_missing')).status).toBe(404)

      const models = (await v.get(`/api/team/models?from=${from}&to=${to}`)).json
      const cell = models.matrix.find((m: any) => m.model === 'claude-sonnet-4' && m.category === 'coding')
      expect(cell).toMatchObject({ cost: 2, calls: 1, people: 1 })
      expect(models.by_model.find((m: any) => m.name === 'claude-sonnet-4')).toMatchObject({ cost: 3, people: 2, calls: 2 })

      const projects = (await v.get(`/api/team/projects?from=${from}&to=${to}`)).json.projects
      expect(projects[0]).toMatchObject({ project: 'alpha', cost: 6, calls: 3, people: 2, top_person: 'Ann' })

      const meta = (await v.get('/api/team/meta')).json
      expect(meta).toMatchObject({ org_name: '', detail_levels: ['summary'], accept_findings: false, viewer: { name: 'Boss' }, teams: ['core', 'web'] })
      expect(meta.people.map((p: any) => p.name).sort()).toEqual(['Ann', 'Bob'])

      expect((await v.get('/api/team/overview?from=garbage')).status).toBe(400)
      expect((await v.get(`/api/team/overview?from=${to}&to=${from}`)).status).toBe(400)
    })

    it('insights rules fire on crafted data', async () => {
      t = await startServer(backend)
      const spans = async (who: Awaited<ReturnType<typeof enrollPerson>>, items: Parameters<typeof span>[0][]) => send(t, who.cred, items.map(span))
      const cached = { input: 100, cacheRead: 900 }
      const [p1, p2, p3, p4, p5] = await Promise.all(['A', 'B', 'C', 'D', 'E'].map(n => enrollPerson(t, `P${n}`)))
      // A, B, C: healthy cache ratio (0.9). D: none. E: premium on simple + spike.
      for (const [p, id] of [[p1!, 'a'], [p2!, 'b'], [p3!, 'c']] as const) await spans(p, [{ id: `${id}1`, at: daysAgo(1), cost: 2, ...cached }])
      await spans(p4!, [{ id: 'd1', at: daysAgo(1), cost: 2, input: 1000, cacheRead: 0 }])
      await spans(p5!, [
        { id: 'e1', at: daysAgo(1), cost: 20, model: 'claude-opus-4', category: 'conversation', ...cached },
        { id: 'e2', at: daysAgo(1), cost: 1, model: 'claude-haiku-4', category: 'general', ...cached },
        { id: 'e3', at: daysAgo(9), cost: 2, model: 'claude-sonnet-4', category: 'coding', ...cached },
      ])
      const v = await viewerClient(t)
      const { insights, findings } = (await v.get(`/api/team/insights?from=${dayStr(daysAgo(12))}&to=${dayStr(daysAgo(0))}`)).json
      expect(findings).toBeUndefined()
      const by = (id: string) => insights.filter((i: any) => i.id === id)
      expect(by('low-cache-read').map((i: any) => i.person)).toEqual(['PD'])
      expect(by('low-cache-read')[0]).toMatchObject({ severity: 'warn' })
      expect(by('premium-on-simple').map((i: any) => i.person)).toEqual(['PE'])
      expect(by('premium-on-simple')[0].value).toBeCloseTo(20 / 21)
      expect(by('spend-spike').map((i: any) => i.person)).toEqual(['PE'])
      for (const i of insights) expect(typeof i.title).toBe('string')
    })

    it('insights stay quiet on normal data', async () => {
      t = await startServer(backend)
      const people = await Promise.all(['A', 'B', 'C'].map(n => enrollPerson(t, `Q${n}`)))
      for (const [n, p] of people.entries()) {
        await send(t, p.cred, [span({ id: `q${n}1`, at: daysAgo(1), cost: 2, input: 100, cacheRead: 900 }), span({ id: `q${n}2`, at: daysAgo(8), cost: 2, input: 100, cacheRead: 900 })])
      }
      const v = await viewerClient(t)
      expect((await v.get('/api/team/insights')).json.insights).toEqual([])
    })
  })

  describe('static viewer', () => {
    it('serves a hint page when the viewer is not built', async () => {
      t = await startServer(backend)
      const r = await fetch(`${t.base}/`)
      expect(r.status).toBe(200)
      expect(await r.text()).toContain('npm run build:dash')
    })

    it('serves dist/team-dash with SPA fallback and no path traversal', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'codeburn-team-static-'))
      await writeFile(join(dir, 'team.html'), '<!doctype html><title>team</title>')
      await writeFile(join(dir, 'app.js'), 'console.log(1)')
      t = await startServer(backend, {}, dir)
      expect(await (await fetch(`${t.base}/`)).text()).toContain('<title>team</title>')
      expect(await (await fetch(`${t.base}/people/p_1`)).text()).toContain('<title>team</title>')
      const js = await fetch(`${t.base}/app.js`)
      expect(js.headers.get('content-type')).toContain('javascript')
      expect((await fetch(`${t.base}/missing.js`)).status).toBe(404)
      const trav = await fetch(`${t.base}/..%2f..%2fpackage.json`)
      expect(await trav.text()).not.toContain('"name"')
      expect((await fetch(`${t.base}/v1/nothing`)).status).toBe(404)
    })
  })

  describe('retention', () => {
    it('prunes spans and rollups older than retention_days', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      await send(t, a.cred, [span({ id: 'old', at: hoursAgo(100 * 24) }), span({ id: 'new', at: hoursAgo(2) })])
      const r = await t.store.prune(30)
      expect(r.spans).toBe(1)
      expect((await t.store.all('SELECT span_id FROM spans')).map(x => x.span_id)).toEqual(['new'])
      expect(await t.store.all('SELECT day FROM daily_usage')).toHaveLength(1)
    })
  })
})
