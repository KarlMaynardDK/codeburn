import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { arr, b, BACKENDS, daysAgo, dayStr, enrollPerson, hoursAgo, i, payload, post, s, send, span, startServer, viewerClient, type TestServer } from './helpers.js'

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

    it('a device can revoke its own credential and nothing else', async () => {
      t = await startServer(backend)
      const doc = await (await fetch(`${t.base}/.well-known/codeburn-export.json`)).json() as any
      expect(doc.revoke_path).toBe('/v1/revoke')
      const a = await enrollPerson(t, 'Ann')
      const b = await enrollPerson(t, 'Bob')
      expect((await post(t.base, '/v1/revoke', {})).status).toBe(401)
      expect((await post(t.base, '/v1/revoke', {}, { authorization: 'Bearer cbd_bogus' })).status).toBe(401)
      const r = await post(t.base, '/v1/revoke', {}, { authorization: `Bearer ${a.cred}` })
      expect(r.status).toBe(200)
      expect(r.json).toEqual({ ok: true })
      expect((await send(t, a.cred, [span({ id: 'a1' })])).status).toBe(401)
      expect((await post(t.base, '/v1/revoke', {}, { authorization: `Bearer ${a.cred}` })).status).toBe(401)
      expect((await send(t, b.cred, [span({ id: 'b1' })])).status).toBe(200)
      const people = await t.store.listPeople()
      expect(people.find(p => p.name === 'Ann')!.revoked_at).toBeNull()
      expect(people.find(p => p.name === 'Ann')!.devices[0]!.revoked_at).not.toBeNull()
      expect(people.find(p => p.name === 'Bob')!.devices[0]!.revoked_at).toBeNull()
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

    it('records the X-Codeburn-Client-Version header and ignores malformed values', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const version = async () => (await t.store.all('SELECT client_version FROM devices'))[0]!.client_version
      expect(await version()).toBeNull()
      await post(t.base, '/v1/traces', payload([span({ id: 's1' })]), { authorization: `Bearer ${a.cred}`, 'x-codeburn-client-version': '0.9.7-team.202610' })
      expect(await version()).toBe('0.9.7-team.202610')
      await post(t.base, '/v1/traces', payload([span({ id: 's2' })]), { authorization: `Bearer ${a.cred}`, 'x-codeburn-client-version': '1.0 <script>' })
      expect(await version()).toBe('0.9.7-team.202610')
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

  describe('schema v2 fields', () => {
    it('reports speed, billing, turn outcomes, lines and request weight', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      await send(t, a.cred, [
        span({ id: 'v1', speed: 'fast', cost: 2, attrs: [b('ai.turn_start', true), b('ai.turn_has_edits', true), i('ai.lines_added', 40), i('ai.lines_removed', 4), s('ai.billing_route', 'bedrock'), s('ai.billing_mode', 'metered'), b('ai.cost_estimated', true), i('ai.reasoning_tokens', 7)] }),
        span({ id: 'v2', cost: 1, attrs: [b('ai.turn_start', true), b('ai.turn_has_edits', true), i('ai.turn_retries', 3), i('ai.tool_errors', 2), b('ai.plan_mode', true)] }),
        // Supplementary accounting: cost counts, the call does not.
        span({ id: 'v3', cost: 0.5, attrs: [i('ai.request_weight', 0), b('ai.subscription_covered', true)] }),
      ], 'summary')
      const v = await viewerClient(t)
      const day = dayStr(hoursAgo(1))
      const ov = (await v.get(`/api/team/overview?from=${day}&to=${day}`)).json
      expect(ov.totals).toMatchObject({
        cost: 3.5, calls: 2, turns: 2, edit_turns: 2, one_shot_turns: 1, retries: 3, one_shot_rate: 0.5, lines_added: 40, lines_removed: 4,
        tool_errors: 2, plan_mode_calls: 1, estimated_cost_usd: 2, covered_cost_usd: 0.5, reasoning: 7,
      })
      expect(ov.by_speed).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fast', cost: 2, calls: 1 }), expect.objectContaining({ name: 'standard', cost: 1.5, calls: 1 })]))
      expect(ov.by_route).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'bedrock', cost: 2 }), expect.objectContaining({ name: 'direct', cost: 1.5 })]))
      expect(ov.by_billing).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'metered', cost: 2 }), expect.objectContaining({ name: 'unknown' })]))
      const people = (await v.get(`/api/team/people?from=${day}&to=${day}`)).json.people
      expect(people[0]).toMatchObject({ calls: 2, one_shot_rate: 0.5, lines_added: 40 })
    })

    it('rolls up MCP tools, skills, subagent types and plan mode', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const c = await enrollPerson(t, 'Cy')
      await send(t, a.cred, [
        span({ id: 'n1', cost: 1, attrs: [arr('ai.mcp_tools', ['mcp__github__create_pr', 'mcp__github__get_issue']), arr('ai.skills', ['docx']), b('ai.plan_mode', true)] }),
        span({ id: 'n2', cost: 2, attrs: [arr('ai.mcp_tools', ['mcp__github__create_pr']), arr('ai.subagent_types', ['Explore'])] }),
      ], 'summary')
      await send(t, c.cred, [span({ id: 'n3', cost: 4, attrs: [arr('ai.mcp_tools', ['mcp__github__create_pr', 'bad\nname'])] })], 'summary')
      const v = await viewerClient(t)
      const day = dayStr(hoursAgo(1))
      const r = (await v.get(`/api/team/tools?from=${day}&to=${day}`)).json
      expect(r.names).toEqual([
        { kind: 'mcp', name: 'mcp__github__create_pr', calls: 3, cost: 7, people: 2 },
        { kind: 'mcp', name: 'mcp__github__get_issue', calls: 1, cost: 1, people: 1 },
        { kind: 'skill', name: 'docx', calls: 1, cost: 1, people: 1 },
        { kind: 'subagent', name: 'Explore', calls: 1, cost: 2, people: 1 },
      ])
      expect(r.plan_mode).toEqual({ calls: 1, people: 1, share: 1 / 3 })
      // The person filter (forced for member viewers) scopes the names too.
      const member = (await v.get(`/api/team/tools?from=${day}&to=${day}&person=${c.person.id}`)).json
      expect(member.names).toEqual([{ kind: 'mcp', name: 'mcp__github__create_pr', calls: 1, cost: 4, people: 1 }])
    })

    it('stores git attribution only with session detail and joins it to session spend', async () => {
      const attribution = (trace: string) => ({
        resourceSpans: [{
          resource: { attributes: [s('codeburn.device_id', 'x'), s('codeburn.attribution_methodology', 'timestamp-window')] },
          scopeSpans: [{ spans: [
            { traceId: trace, spanId: 'as1', name: 'codeburn.session.attribution', startTimeUnixNano: (BigInt(hoursAgo(2)) * 1_000_000n).toString(), endTimeUnixNano: (BigInt(hoursAgo(1)) * 1_000_000n).toString(),
              attributes: [s('ai.project', 'app'), s('git.repo', 'github.com/acme/app'), i('git.commit_count', 2), arr('git.pr_links', ['https://github.com/acme/app/pull/7'])] },
            { traceId: trace, spanId: 'ac1', name: 'codeburn.commit', startTimeUnixNano: (BigInt(hoursAgo(1)) * 1_000_000n).toString(), endTimeUnixNano: (BigInt(hoursAgo(1)) * 1_000_000n).toString(),
              attributes: [s('git.repo', 'github.com/acme/app'), s('git.sha', 'ABCDEF1234567'), b('git.in_main', true), b('git.was_reverted', false)] },
            { traceId: trace, spanId: 'ac2', name: 'codeburn.commit', startTimeUnixNano: (BigInt(hoursAgo(1)) * 1_000_000n).toString(), endTimeUnixNano: (BigInt(hoursAgo(1)) * 1_000_000n).toString(),
              attributes: [s('git.repo', 'github.com/acme/app'), s('git.sha', 'fedcba7654321'), b('git.in_main', true), b('git.was_reverted', true)] },
          ] }],
        }],
      })
      t = await startServer(backend)
      let a = await enrollPerson(t, 'Ann')
      await post(t.base, '/v1/traces', attribution('t'.repeat(32)), { authorization: `Bearer ${a.cred}` })
      expect(await t.store.all('SELECT * FROM work_sessions')).toEqual([])
      await t.cleanup()

      t = await startServer(backend, { accept_session_detail: true })
      a = await enrollPerson(t, 'Ann')
      const trace = 't'.repeat(32)
      await send(t, a.cred, [span({ id: 'w1', trace, cost: 3, at: hoursAgo(2) })], 'sessions')
      const r = await post(t.base, '/v1/traces', attribution(trace), { authorization: `Bearer ${a.cred}` })
      expect(r.json.partialSuccess).toEqual({})
      const v = await viewerClient(t)
      const day = dayStr(hoursAgo(1))
      const work = (await v.get(`/api/team/work?from=${dayStr(hoursAgo(2))}&to=${day}`)).json
      expect(work.repos).toEqual([{ repo: 'github.com/acme/app', sessions: 1, cost: 3, people: 1, prs: 1, commits: 2, landed: 2, reverted: 1 }])
      expect(work.prs).toEqual([{ url: 'https://github.com/acme/app/pull/7', repo: 'github.com/acme/app', sessions: 1, cost: 3, people: 1 }])
      expect((await t.store.all('SELECT sha FROM work_commits ORDER BY sha')).map(x => x.sha)).toEqual(['abcdef1234567', 'fedcba7654321'])
    })

    it('records the coverage date per device and never moves it backwards', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const auth = { authorization: `Bearer ${a.cred}` }
      await post(t.base, '/v1/traces', payload([span({ id: 'c1' })], 'summary', [s('codeburn.coverage_through', '2026-10-20')]), auth)
      await post(t.base, '/v1/traces', payload([span({ id: 'c2' })], 'summary', [s('codeburn.coverage_through', '2026-10-18')]), auth)
      const v = await viewerClient(t)
      const day = dayStr(hoursAgo(1))
      expect((await v.get(`/api/team/people?from=${day}&to=${day}`)).json.people[0].data_through).toBe('2026-10-20')
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

  describe('member profile', () => {
    const asMember = async (personId: string, name = 'Ann') => {
      const token = await t.store.loginSso({ name, role: 'member', personId, subject: '1' })
      const headers = { cookie: `cb_team_session=${token}`, origin: `http://${t.host}`, 'content-type': 'application/json' }
      const get = async (path: string) => {
        const res = await fetch(t.base + path, { headers })
        return { status: res.status, json: (await res.json().catch(() => null)) as any }
      }
      const save = async (body: unknown) => {
        const res = await fetch(t.base + '/api/team/profile', { method: 'POST', headers, body: JSON.stringify(body) })
        return { status: res.status, json: (await res.json().catch(() => null)) as any }
      }
      return { get, save, token }
    }

    it('lets a member read and change their name, team and hidden projects, and hides them from admins', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann', 'Platform')
      await enrollPerson(t, 'Bob', 'Web')
      await send(t, a.cred, [span({ id: 's1', project: 'secret', cost: 2 }), span({ id: 's2', project: 'app', cost: 3 })])
      const m = await asMember(a.person.id)

      const before = await m.get('/api/team/profile')
      expect(before.json).toMatchObject({ name: 'Ann', email: 'ann@example.com', team: 'Platform', teams: ['Platform', 'Web'] })
      expect(before.json.projects).toEqual([{ project: 'app', hidden: false, cost: 3 }, { project: 'secret', hidden: false, cost: 2 }].sort((x, y) => y.cost - x.cost))

      const saved = await m.save({ name: 'Ann Lee', team: 'web', hidden_projects: ['secret'] })
      expect(saved.status).toBe(200)
      expect(saved.json).toMatchObject({ name: 'Ann Lee', team: 'Web', email: 'ann@example.com' })
      expect(saved.json.projects).toContainEqual({ project: 'secret', hidden: true, cost: 2 })

      // Admins (viewer key) only ever see "unknown".
      const admin = await viewerClient(t)
      const projects = (await admin.get('/api/team/projects')).json.projects.map((p: any) => p.project).sort()
      expect(projects).toEqual(['app', 'unknown'])
      expect(JSON.stringify((await admin.get('/api/team/people')).json)).not.toContain('secret')
      expect((await admin.get('/api/team/meta')).json.people.find((p: any) => p.id === a.person.id)).toMatchObject({ name: 'Ann Lee', team: 'Web' })
      expect((await m.get('/api/team/meta')).json.viewer.name).toBe('Ann Lee')

      // New usage for a hidden project is hidden on arrival; unhiding restores the names.
      await send(t, a.cred, [span({ id: 's3', project: 'secret', cost: 1 })])
      expect((await admin.get('/api/team/projects')).json.projects.map((p: any) => p.project).sort()).toEqual(['app', 'unknown'])
      await m.save({ hidden_projects: [] })
      expect((await admin.get('/api/team/projects')).json.projects.map((p: any) => p.project).sort()).toEqual(['app', 'secret'])
    })

    it('rejects invalid input without changing anything', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann', 'Platform')
      await send(t, a.cred, [span({ id: 's1', project: 'secret' })])
      const m = await asMember(a.person.id)
      expect((await m.save({ name: '   ' })).json.error).toBe('invalid_name')
      expect((await m.save({ team: '' })).json.error).toBe('invalid_team')
      expect((await m.save({ name: 5 })).json.error).toBe('invalid_name')
      expect((await m.save({ hidden_projects: 'secret' })).json.error).toBe('invalid_projects')
      expect((await m.save({ hidden_projects: ['unknown'] })).json.error).toBe('invalid_projects')
      // A bad field means nothing else in the same request is applied.
      expect((await m.save({ hidden_projects: ['secret', ''], name: 'Changed' })).status).toBe(400)
      expect((await m.save({ name: 'Changed', team: '' })).status).toBe(400)
      const p = (await m.get('/api/team/profile')).json
      expect(p.name).toBe('Ann')
      expect(p.projects).toContainEqual({ project: 'secret', hidden: false, cost: 0.5 })
    })

    it('lets an admin add a person and returns an install token that enrolls', async () => {
      t = await startServer(backend)
      const admin = await viewerClient(t)
      const add = (body: unknown) => fetch(t.base + '/api/team/admin/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: admin.cookie, origin: `http://${t.host}` },
        body: JSON.stringify(body),
      })
      const ok = await add({ name: 'Dana', email: 'dana@example.com', team: 'Core' })
      expect(ok.status).toBe(200)
      const json = await ok.json() as any
      expect(json.token).toMatch(/^cbe_/)
      expect(json.person).toMatchObject({ name: 'Dana', email: 'dana@example.com', team: 'Core' })
      expect((await add({ name: 'Dana 2', email: 'DANA@example.com', team: 'core' })).status).toBe(409)
      expect((await add({ name: 'X', email: 'nope', team: 'core' })).status).toBe(400)
      expect((await add({ name: '', email: 'x@example.com', team: 'core' })).status).toBe(400)
      const enrolled = await post(t.base, '/v1/enroll', { token: json.token })
      expect(enrolled.status).toBe(200)

      const a = await enrollPerson(t, 'Ann')
      const m = await asMember(a.person.id)
      const denied = await fetch(t.base + '/api/team/admin/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `cb_team_session=${m.token}`, origin: `http://${t.host}` },
        body: JSON.stringify({ name: 'E', email: 'e@example.com', team: 'x' }),
      })
      expect(denied.status).toBe(404)
    })

    it('only edits the signed-in member; admins and registrants have no profile', async () => {
      t = await startServer(backend)
      const a = await enrollPerson(t, 'Ann')
      const b = await enrollPerson(t, 'Bob')
      const m = await asMember(a.person.id)
      // The body cannot name another person: identity comes from the session.
      await m.save({ name: 'Mallory', person_id: b.person.id, id: b.person.id })
      expect((await t.store.getPerson(b.person.id))!.name).toBe('Bob')
      expect((await t.store.getPerson(a.person.id))!.name).toBe('Mallory')

      const admin = await viewerClient(t)
      expect((await admin.get('/api/team/profile')).status).toBe(404)
      const reg = await t.store.loginSso({ name: 'New', role: 'registrant', email: 'new@example.com', subject: '9' })
      const r = await fetch(t.base + '/api/team/profile', { headers: { cookie: `cb_team_session=${reg}`, origin: `http://${t.host}` } })
      expect(r.status).toBe(403)
      const anon = await fetch(t.base + '/api/team/profile', { headers: { origin: `http://${t.host}` } })
      expect(anon.status).toBe(401)
    })
  })
  describe('team admin', () => {
    const asTeamAdmin = async (personId: string, teams: string[], name = 'Lead') => {
      await t.store.setTeamAdmin(personId, teams)
      const token = await t.store.loginSso({ name, role: 'member', personId, subject: 'ta' })
      const headers = { cookie: `cb_team_session=${token}`, origin: `http://${t.host}`, 'content-type': 'application/json' }
      const get = async (path: string) => {
        const res = await fetch(t.base + path, { headers })
        return { status: res.status, json: (await res.json().catch(() => null)) as any }
      }
      const postJson = async (path: string, body: unknown = {}) => {
        const res = await fetch(t.base + path, { method: 'POST', headers, body: JSON.stringify(body) })
        return { status: res.status, json: (await res.json().catch(() => null)) as any }
      }
      return { get, postJson }
    }

    const seed = async () => {
      const lead = await enrollPerson(t, 'Lead', 'Web')
      const ann = await enrollPerson(t, 'Ann', 'Web')
      const bob = await enrollPerson(t, 'Bob', 'Data')
      const cy = await enrollPerson(t, 'Cy', 'Ops')
      for (const [who, id] of [[lead, 'l'], [ann, 'a'], [bob, 'b'], [cy, 'c']] as const) {
        await send(t, who.cred, [span({ id, at: daysAgo(1), cost: 1 })])
      }
      return { lead, ann, bob, cy }
    }

    it('sees only the teams they administer, plus themselves', async () => {
      t = await startServer(backend)
      const { lead, ann, bob, cy } = await seed()
      const ta = await asTeamAdmin(lead.person.id, ['Web', 'Data'])
      const meta = (await ta.get('/api/team/meta')).json
      expect(meta.viewer.role).toBe('team_admin')
      expect(meta.teams).toEqual(['Data', 'Web'])
      expect(meta.people.map((p: any) => p.name).sort()).toEqual(['Ann', 'Bob', 'Lead'])
      const people = (await ta.get('/api/team/people')).json.people.map((p: any) => p.name).sort()
      expect(people).toEqual(['Ann', 'Bob', 'Lead'])
      expect((await ta.get(`/api/team/people/${bob.person.id}`)).status).toBe(200)
      expect((await ta.get(`/api/team/people/${cy.person.id}`)).status).toBe(404)
      expect((await ta.get(`/api/team/overview?person=${cy.person.id}`)).status).toBe(404)
      // A team outside the scope is ignored rather than widening it.
      const ops = (await ta.get('/api/team/people?team=Ops')).json.people.map((p: any) => p.name).sort()
      expect(ops).toEqual(['Ann', 'Bob', 'Lead'])
      expect((await ta.get('/api/team/people?team=Data')).json.people.map((p: any) => p.name)).toEqual(['Bob'])
      expect((await ta.get('/api/team/overview')).json.totals.active_people).toBe(3)
      expect((await ta.get(`/api/team/people/${ann.person.id}`)).status).toBe(200)
    })

    it('still sees their own usage when their own team is not administered', async () => {
      t = await startServer(backend)
      const { lead } = await seed()
      const ta = await asTeamAdmin(lead.person.id, ['Data'])
      expect((await ta.get('/api/team/people')).json.people.map((p: any) => p.name).sort()).toEqual(['Bob', 'Lead'])
    })

    it('adds people and issues tokens only inside their teams', async () => {
      t = await startServer(backend)
      const { lead, ann, cy } = await seed()
      const ta = await asTeamAdmin(lead.person.id, ['Web'])
      const ok = await ta.postJson('/api/team/admin/people', { name: 'Dee', email: 'dee@example.com', team: ' web ' })
      expect(ok.status).toBe(200)
      expect(ok.json.person.team).toBe('Web')
      expect((await ta.postJson('/api/team/admin/people', { name: 'Eve', email: 'eve@example.com', team: 'Ops' })).status).toBe(403)
      expect((await ta.postJson('/api/team/admin/people', { name: 'Eve', email: 'eve@example.com', team: 'Brand New' })).status).toBe(403)
      const tok = await ta.postJson(`/api/team/admin/people/${ann.person.id}/token`)
      expect(tok.status).toBe(200)
      expect(tok.json.token).toMatch(/^cbe_/)
      expect((await ta.postJson(`/api/team/admin/people/${cy.person.id}/token`)).status).toBe(404)
    })

    it('cannot grant the role, and plain members cannot use any admin endpoint', async () => {
      t = await startServer(backend)
      const { lead, ann } = await seed()
      const ta = await asTeamAdmin(lead.person.id, ['Web'])
      expect((await ta.postJson(`/api/team/admin/people/${ann.person.id}/team-admin`, { teams: ['Web'] })).status).toBe(404)
      expect(await t.store.teamsAdministered(ann.person.id)).toEqual([])
      const token = await t.store.loginSso({ name: 'Ann', role: 'member', personId: ann.person.id, subject: 'm' })
      const res = await fetch(t.base + `/api/team/admin/people/${ann.person.id}/token`, {
        method: 'POST', headers: { cookie: `cb_team_session=${token}`, origin: `http://${t.host}`, 'content-type': 'application/json' }, body: '{}',
      })
      expect(res.status).toBe(404)
    })

    it('lets a full admin grant and revoke, and the change applies on the next request', async () => {
      t = await startServer(backend)
      const { lead } = await seed()
      const admin = await viewerClient(t)
      const grant = (teams: string[]) => fetch(t.base + `/api/team/admin/people/${lead.person.id}/team-admin`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: admin.cookie, origin: `http://${t.host}` }, body: JSON.stringify({ teams }),
      })
      const token = await t.store.loginSso({ name: 'Lead', role: 'member', personId: lead.person.id, subject: 'x' })
      const me = async () => (await (await fetch(t.base + '/api/team/meta', { headers: { cookie: `cb_team_session=${token}`, origin: `http://${t.host}` } })).json() as any).viewer.role
      expect(await me()).toBe('member')
      const r = await grant(['web', 'Data'])
      expect(r.status).toBe(200)
      expect((await r.json() as any).teams).toEqual(['Data', 'Web'])
      expect(await me()).toBe('team_admin')
      expect((await admin.get('/api/team/meta')).json.people.find((p: any) => p.id === lead.person.id).team_admin_of).toEqual(['Data', 'Web'])
      expect((await grant([])).status).toBe(200)
      expect(await me()).toBe('member')
      expect((await grant(['x'.repeat(200)])).status).toBe(400)
    })

    it('drops the role when the person is deleted and moves it on merge', async () => {
      t = await startServer(backend)
      const { lead, ann } = await seed()
      await t.store.setTeamAdmin(lead.person.id, ['Web'])
      await t.store.mergePerson(lead.person.id, ann.person.id)
      expect(await t.store.teamsAdministered(ann.person.id)).toEqual(['Web'])
      expect(await t.store.teamsAdministered(lead.person.id)).toEqual([])
      await t.store.deletePerson(ann.person.id, true)
      expect(await t.store.teamsAdministered(ann.person.id)).toEqual([])
    })
  })
})
