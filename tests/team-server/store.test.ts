import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../src/team-server/config.js'
import { canonicalTeam, migrate, SCHEMA_VERSION, type SpanRecord } from '../../src/team-server/store.js'
import { toPgSql } from '../../src/team-server/store-postgres.js'
import { BACKENDS, makeStore, type TestStore } from './helpers.js'
import * as rollup from '../../src/team-server/rollup.js'

function spanRecord(o: Partial<SpanRecord> & { span_id: string; ts: string }): SpanRecord {
  return {
    trace_id: 't', provider: 'p', model: 'm', project: 'p', category: 'c', input: 1, output: 1, cache_read: 0, cache_write: 0, cost_usd: 1,
    detail_level: 'summary', work_unit_id: null, session_role: null, call_count: null, session_duration_ms: null,
    speed: 'standard', route: '', billing: '', cost_estimated: false, subscription_covered: false, reasoning: 0, web_search: 0,
    cache_write_1h: 0, savings_usd: 0, nano_aiu: 0, request_weight: 1, lines_added: 0, lines_removed: 0, tool_errors: 0,
    interrupted: false, user_modified: false, active_ms: 0, tool_wait_ms: 0, turn_start: false, turn_has_edits: false, turn_retries: 0,
    plan_mode: false, mcp_tools: [], skills: [], subagent_types: [],
    ...o,
  }
}

describe('config', () => {
  it('writes defaults when team-server.json is absent and reads overrides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-team-cfg-'))
    expect(loadConfig(dir)).toEqual({ accept_session_detail: false, accept_findings: false, accept_coaching: false, install_mode: 'manual', retention_days: 400, org_name: '' })
    expect(JSON.parse(await readFile(join(dir, 'team-server.json'), 'utf-8')).retention_days).toBe(400)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'team-server.json'), JSON.stringify({ accept_session_detail: true, retention_days: 30, org_name: 'Acme', accept_findings: 'yes' }))
    expect(loadConfig(dir)).toMatchObject({ accept_session_detail: true, accept_findings: false, retention_days: 30, org_name: 'Acme' })
  })
})

describe('canonicalTeam', () => {
  it('accepts new names and reuses existing spellings', () => {
    expect(canonicalTeam('  Data Science ', ['Platform'])).toBe('Data Science')
    expect(canonicalTeam('platform', ['Platform', 'Web'])).toBe('Platform')
    expect(canonicalTeam(' PLATFORM', ['Platform'])).toBe('Platform')
    expect(canonicalTeam('Platform team', ['Platform'])).toBe('Platform team')
  })

  it('rejects empty, overlong and control-character names', () => {
    expect(canonicalTeam('   ', [])).toBeNull()
    expect(canonicalTeam('x'.repeat(65), [])).toBeNull()
    expect(canonicalTeam('x'.repeat(64), [])).toBe('x'.repeat(64))
    expect(canonicalTeam('a\nb', [])).toBeNull()
  })
})

describe('postgres placeholder translation', () => {
  it('numbers ? placeholders', () => {
    expect(toPgSql('SELECT * FROM t WHERE a = ? AND b IN (?, ?)')).toBe('SELECT * FROM t WHERE a = $1 AND b IN ($2, $3)')
  })
})

describe.each(BACKENDS)('store (%s)', backend => {
  let ts: TestStore
  afterEach(async () => { await ts?.cleanup() })

  it('migrates idempotently', async () => {
    ts = await makeStore(backend)
    await migrate(ts.store.db)
    await migrate(ts.store.db)
    expect(await ts.store.all('SELECT version FROM schema_version')).toEqual([{ version: SCHEMA_VERSION }])
  })

  it('upgrades a v1 database in place and rebuilds daily_usage from its spans', async () => {
    ts = await makeStore(backend)
    const db = ts.store.db
    const int = backend === 'postgres' ? 'BIGINT' : 'INTEGER'
    const real = backend === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'
    // Recreate the v1 shape of the tables that v2 changes, with data in them.
    for (const t of ['spans', 'daily_usage', 'devices']) await db.all(`DROP TABLE ${t}`)
    await db.all(`CREATE TABLE devices (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, cred_hash TEXT NOT NULL UNIQUE, label TEXT, client_device_id TEXT, created_at TEXT NOT NULL, last_seen TEXT, revoked_at TEXT)`)
    await db.all(`CREATE TABLE spans (span_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, device_id TEXT NOT NULL, trace_id TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL, category TEXT NOT NULL, input ${int} NOT NULL, output ${int} NOT NULL, cache_read ${int} NOT NULL, cache_write ${int} NOT NULL, cost_usd ${real} NOT NULL, detail_level TEXT NOT NULL, work_unit_id TEXT, session_role TEXT, call_count ${int}, session_duration_ms ${int})`)
    await db.all(`CREATE TABLE daily_usage (person_id TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL, category TEXT NOT NULL, input ${int} NOT NULL, output ${int} NOT NULL, cache_read ${int} NOT NULL, cache_write ${int} NOT NULL, cost_usd ${real} NOT NULL, calls ${int} NOT NULL, PRIMARY KEY (person_id, day, provider, model, project, category))`)
    await db.all('UPDATE schema_version SET version = 1')
    for (const id of ['s1', 's2']) {
      await db.all(`INSERT INTO spans (span_id, person_id, device_id, trace_id, ts, day, provider, model, project, category, input, output, cache_read, cache_write, cost_usd, detail_level) VALUES (?, 'p1', 'd1', 't', '2026-10-01T10:00:00.000Z', '2026-10-01', 'claude', 'm', 'app', 'coding', 10, 5, 0, 0, 1.5, 'summary')`, [id])
    }
    await db.all(`INSERT INTO daily_usage VALUES ('p1', '2026-10-01', 'claude', 'm', 'app', 'coding', 20, 10, 0, 0, 3, 2)`)

    await migrate(db)
    expect(await ts.store.all('SELECT version FROM schema_version')).toEqual([{ version: SCHEMA_VERSION }])
    const [row] = await ts.store.all('SELECT * FROM daily_usage')
    expect(row).toMatchObject({ person_id: 'p1', speed: 'unknown', route: '', billing: '' })
    expect(Number(row!.calls)).toBe(2)
    expect(Number(row!.cost_usd)).toBe(3)
    expect(Number(row!.turns)).toBe(0)
    const [span] = await ts.store.all('SELECT request_weight, mcp_tools FROM spans WHERE span_id = ?', ['s1'])
    expect(Number(span!.request_weight)).toBe(1)
    expect(span!.mcp_tools).toBe('')
    expect(await ts.store.all('SELECT coverage_through FROM devices')).toEqual([])
    await migrate(db)
    expect(await ts.store.all('SELECT version FROM schema_version')).toEqual([{ version: SCHEMA_VERSION }])
  })

  it('rolls new span fields up into daily_usage and daily_names', async () => {
    ts = await makeStore(backend)
    const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: '' })
    const ts0 = new Date().toISOString()
    await ts.store.ingestSpans(person.id, 'd', [
      spanRecord({ span_id: 'a', ts: ts0, speed: 'fast', cost_usd: 2, cost_estimated: true, turn_start: true, turn_has_edits: true, lines_added: 10, mcp_tools: ['mcp__gh__pr', 'mcp__gh__issue'], skills: ['docx'] }),
      spanRecord({ span_id: 'b', ts: ts0, speed: 'fast', cost_usd: 1, turn_start: true, turn_has_edits: true, turn_retries: 2, mcp_tools: ['mcp__gh__pr'], plan_mode: true }),
      spanRecord({ span_id: 'c', ts: ts0, speed: 'fast', cost_usd: 0.5, request_weight: 0, subscription_covered: true }),
    ], false)
    const [u] = await ts.store.all('SELECT * FROM daily_usage')
    expect([u!.speed, ...['calls', 'turns', 'edit_turns', 'one_shot_turns', 'retries', 'lines_added', 'plan_mode_calls'].map(c => Number(u![c]))])
      .toEqual(['fast', 2, 2, 2, 1, 2, 10, 1])
    expect(Number(u!.estimated_cost_usd)).toBe(2)
    expect(Number(u!.covered_cost_usd)).toBe(0.5)
    const names = await ts.store.all('SELECT kind, name, calls, cost_usd FROM daily_names ORDER BY kind, name')
    expect(names.map(r => [r.kind, r.name, Number(r.calls), Number(r.cost_usd)])).toEqual([
      ['mcp', 'mcp__gh__issue', 1, 2], ['mcp', 'mcp__gh__pr', 2, 3], ['skill', 'docx', 1, 2],
    ])
  })

  it('counts model switches and the context they re-sent into daily_usage', async () => {
    ts = await makeStore(backend)
    const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: '' })
    const ts0 = new Date().toISOString()
    await ts.store.ingestSpans(person.id, 'd', [
      spanRecord({ span_id: 'a', ts: ts0, model_switch_tokens: 80_000 }),
      spanRecord({ span_id: 'b', ts: ts0, model_switch_tokens: 40_000 }),
      spanRecord({ span_id: 'c', ts: ts0 }),
    ], false)
    const [u] = await ts.store.all('SELECT calls, model_switches, model_switch_tokens FROM daily_usage')
    expect([Number(u!.calls), Number(u!.model_switches), Number(u!.model_switch_tokens)]).toEqual([3, 2, 120_000])
    // Re-sending the same span (sync reset + push --since all) replaces it, it does not count twice.
    await ts.store.ingestSpans(person.id, 'd', [spanRecord({ span_id: 'a', ts: ts0, model_switch_tokens: 80_000 })], false)
    const [again] = await ts.store.all('SELECT model_switches, model_switch_tokens FROM daily_usage')
    expect([Number(again!.model_switches), Number(again!.model_switch_tokens)]).toEqual([2, 120_000])
  })

  it('upgrades a v4 database: adds the span column and rebuilds daily_usage with the switch counts', async () => {
    ts = await makeStore(backend)
    const db = ts.store.db
    const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: '' })
    await ts.store.ingestSpans(person.id, 'd', [spanRecord({ span_id: 'a', ts: new Date().toISOString() })], false)
    // Back to the v4 shape: no span column, daily_usage without the two counts.
    await db.all('ALTER TABLE spans DROP COLUMN model_switch_tokens')
    await db.all('ALTER TABLE daily_usage DROP COLUMN model_switches')
    await db.all('ALTER TABLE daily_usage DROP COLUMN model_switch_tokens')
    await db.all('UPDATE schema_version SET version = 4')
    await migrate(db)
    expect(await ts.store.all('SELECT version FROM schema_version')).toEqual([{ version: SCHEMA_VERSION }])
    const [u] = await ts.store.all('SELECT calls, model_switches, model_switch_tokens FROM daily_usage')
    expect([Number(u!.calls), Number(u!.model_switches), Number(u!.model_switch_tokens)]).toEqual([1, 0, 0])
  })

  it('stores only hashes of secrets', async () => {
    ts = await makeStore(backend)
    const { enrollmentToken } = await ts.store.addPerson({ name: 'Ann', email: 'a@x.io', team: 't' })
    const enrolled = await ts.store.enroll(enrollmentToken, 'lap', null)
    const viewer = await ts.store.addViewer('Boss')
    const dump = JSON.stringify([
      await ts.store.all('SELECT * FROM enrollments'), await ts.store.all('SELECT * FROM devices'), await ts.store.all('SELECT * FROM viewers'),
    ])
    expect(dump).not.toContain(enrollmentToken)
    expect(dump).not.toContain(enrolled!.credential)
    expect(dump).not.toContain(viewer.key)
    expect(await ts.store.authenticateDevice(enrolled!.credential)).toMatchObject({ deviceId: enrolled!.device_id })
    expect(await ts.store.authenticateDevice('cbd_other')).toBeNull()
  })

  it('viewer sessions expire', async () => {
    ts = await makeStore(backend)
    const { key } = await ts.store.addViewer('Boss')
    const login = await ts.store.loginViewer(key)
    expect(await ts.store.viewerForSession(login!.token)).toEqual({ name: 'Boss', role: 'admin' })
    await ts.store.all('UPDATE viewer_sessions SET expires_at = ?', ['2001-01-01T00:00:00.000Z'])
    expect(await ts.store.viewerForSession(login!.token)).toBeNull()
    await ts.store.prune(400)
    expect(await ts.store.all('SELECT * FROM viewer_sessions')).toEqual([])
  })

  it('GitLab sessions carry their role; member sessions end when the person is revoked', async () => {
    ts = await makeStore(backend)
    const { person } = await ts.store.addPerson({ name: 'Ann', email: 'ann@x.io', team: 't' })
    const admin = await ts.store.loginSso({ name: 'Gina', role: 'admin', subject: '1' })
    const member = await ts.store.loginSso({ name: 'Ann G', role: 'member', personId: person.id, subject: '2' })
    const registrant = await ts.store.loginSso({ name: 'Hal', role: 'registrant', email: 'hal@x.io', subject: '3' })
    expect(await ts.store.viewerForSession(admin)).toEqual({ name: 'Gina', role: 'admin' })
    expect(await ts.store.viewerForSession(member)).toEqual({ name: 'Ann G', role: 'member', personId: person.id })
    expect(await ts.store.viewerForSession(registrant)).toEqual({ name: 'Hal', role: 'registrant', email: 'hal@x.io' })
    expect(JSON.stringify(await ts.store.all('SELECT * FROM sso_sessions'))).not.toContain(admin)
    await ts.store.revoke(person.id)
    expect(await ts.store.viewerForSession(member)).toBeNull()
    await ts.store.logoutViewer(admin)
    expect(await ts.store.viewerForSession(admin)).toBeNull()
    await ts.store.all('UPDATE sso_sessions SET expires_at = ?', ['2001-01-01T00:00:00.000Z'])
    expect(await ts.store.viewerForSession(registrant)).toBeNull()
    await ts.store.prune(400)
    expect(await ts.store.all('SELECT * FROM sso_sessions')).toEqual([])
  })

  it('registerSelf creates the person once and upgrades the session', async () => {
    ts = await makeStore(backend)
    await ts.store.addPerson({ name: 'Ann', email: 'ann@x.io', team: 'Platform' })
    const session = await ts.store.loginSso({ name: 'Hal', role: 'registrant', email: 'Hal@X.io', subject: '3' })
    expect(await ts.store.registerSelf(session, '')).toEqual({ error: 'invalid_team' })
    const r = await ts.store.registerSelf(session, 'PLATFORM ')
    if ('error' in r) throw new Error(r.error)
    expect(r.person).toMatchObject({ name: 'Hal', email: 'Hal@X.io', team: 'Platform' })
    expect(await ts.store.viewerForSession(session)).toEqual({ name: 'Hal', role: 'member', personId: r.person.id })
    expect(await ts.store.registerSelf(session, 'core')).toEqual({ error: 'not_registrant' })
    expect(await ts.store.enroll(r.enrollmentToken, null, null)).toMatchObject({ person: { name: 'Hal', email: 'Hal@X.io' } })
    // A second session for the same email (another browser) cannot create a duplicate.
    const other = await ts.store.loginSso({ name: 'Hal', role: 'registrant', email: 'hal@x.io', subject: '3' })
    expect(await ts.store.registerSelf(other, 'core')).toEqual({ error: 'email_taken' })
    expect(await ts.store.peopleByEmail('HAL@x.io')).toHaveLength(1)
    expect(await ts.store.distinctTeams()).toEqual(['Platform'])
  })

  it('a failed ingest transaction rolls back', async () => {
    ts = await makeStore(backend)
    const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: '' })
    const bad = spanRecord({ span_id: 'x', ts: new Date().toISOString() })
    await expect(ts.store.ingestSpans(person.id, 'd', [bad, { ...bad, span_id: 'y', model: null as unknown as string }], false)).rejects.toThrow()
    expect(await ts.store.all('SELECT * FROM spans')).toEqual([])
    expect(await ts.store.all('SELECT * FROM daily_usage')).toEqual([])
  })
  it('merges one person into another, moving spans, rollups and devices', async () => {
    ts = await makeStore(backend)
    const old = (await ts.store.addPerson({ name: 'Old', email: 'a@x.io', team: 'T' })).person
    const cur = (await ts.store.addPerson({ name: 'New', email: 'b@x.io', team: 'T' })).person
    const day = '2026-10-01T10:00:00.000Z'
    await ts.store.ingestSpans(old.id, 'd_old', [spanRecord({ span_id: 'o1', ts: day, lines_added: 7 })], false)
    await ts.store.ingestSpans(cur.id, 'd_new', [spanRecord({ span_id: 'n1', ts: day, lines_added: 3 })], false)

    expect(await ts.store.mergePerson(old.id, old.id)).toBeNull()
    expect(await ts.store.mergePerson('nope', cur.id)).toBeNull()
    expect(await ts.store.mergePerson(old.id, cur.id)).toMatchObject({ spans: 1, days: 1 })

    expect(await ts.store.all('SELECT person_id FROM spans ORDER BY span_id')).toEqual([{ person_id: cur.id }, { person_id: cur.id }])
    expect(await ts.store.all('SELECT person_id FROM daily_usage WHERE person_id = ?', [old.id])).toEqual([])
    const [row] = await ts.store.all('SELECT SUM(lines_added) AS l, SUM(calls) AS c FROM daily_usage WHERE person_id = ?', [cur.id])
    expect(Number(row!.l)).toBe(10)
    expect(Number(row!.c)).toBe(2)
    const people = await ts.store.listPeople()
    expect(people.find(p => p.id === old.id)?.revoked_at).not.toBeNull()
    expect(await ts.store.mergePerson(cur.id, old.id)).toBeNull()
  })
  it('deletes a person only when they own no usage, unless forced', async () => {
    ts = await makeStore(backend)
    const a = (await ts.store.addPerson({ name: 'A', email: '', team: '' })).person
    const b = (await ts.store.addPerson({ name: 'B', email: '', team: '' })).person
    await ts.store.ingestSpans(a.id, 'd', [spanRecord({ span_id: 'a1', ts: new Date().toISOString() })], false)
    expect(await ts.store.deletePerson('nope')).toMatchObject({ deleted: false, reason: 'unknown' })
    expect(await ts.store.deletePerson(a.id)).toMatchObject({ deleted: false, reason: 'has_usage', spans: 1 })
    await ts.store.mergePerson(a.id, b.id)
    expect(await ts.store.deletePerson(a.id)).toEqual({ deleted: true, spans: 0 })
    expect((await ts.store.listPeople()).map(p => p.id)).toEqual([b.id])
    expect(await ts.store.all('SELECT * FROM spans')).toHaveLength(1)
    expect(await ts.store.deletePerson(b.id, true)).toEqual({ deleted: true, spans: 1 })
    expect(await ts.store.all('SELECT * FROM spans')).toEqual([])
    expect(await ts.store.all('SELECT * FROM daily_usage')).toEqual([])
  })
  it('records the client version a device reports and keeps it when later pushes omit it', async () => {
    ts = await makeStore(backend)
    const { enrollmentToken } = await ts.store.addPerson({ name: 'Ann', email: '', team: '' })
    const enrolled = (await ts.store.enroll(enrollmentToken, 'laptop', null))!
    const devices = async () => (await ts.store.listPeople())[0]!.devices
    expect((await devices())[0]!.client_version).toBeNull()
    await ts.store.authenticateDevice(enrolled.credential, '1.2.3')
    expect((await devices())[0]!.client_version).toBe('1.2.3')
    await ts.store.authenticateDevice(enrolled.credential)
    expect((await devices())[0]!.client_version).toBe('1.2.3')
    await ts.store.authenticateDevice(enrolled.credential, '1.3.0-team.7')
    expect((await devices())[0]!.client_version).toBe('1.3.0-team.7')
  })
  describe('hidden projects', () => {
    const now = new Date().toISOString()
    const day = now.slice(0, 10)
    const spans = (extra: Partial<SpanRecord> = {}) => [
      spanRecord({ span_id: 'a1', ts: now, project: 'secret', cost_usd: 2, lines_added: 5, trace_id: 't1', detail_level: 'sessions', session_duration_ms: 1000, ...extra }),
      spanRecord({ span_id: 'a2', ts: now, project: 'app', cost_usd: 3, lines_added: 7, trace_id: 't2', detail_level: 'sessions', session_duration_ms: 1000, ...extra }),
    ]
    const totals = async (id: string) => {
      const [r] = await ts.store.all('SELECT SUM(cost_usd) AS cost, SUM(lines_added) AS loc FROM daily_usage WHERE person_id = ?', [id])
      return { cost: Number(r!.cost), loc: Number(r!.loc) }
    }
    const projectsOf = async (id: string) => (await ts.store.all('SELECT DISTINCT project FROM daily_usage WHERE person_id = ? ORDER BY project', [id])).map(r => r.project)

    it('renames a hidden project to unknown everywhere, keeps the totals, and restores it on unhide', async () => {
      ts = await makeStore(backend)
      const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: 'T' })
      await ts.store.ingestSpans(person.id, 'd', spans(), true)
      expect(await projectsOf(person.id)).toEqual(['app', 'secret'])

      expect(await ts.store.setHiddenProjects(person.id, ['secret'])).toBe(true)
      expect(await projectsOf(person.id)).toEqual(['app', 'unknown'])
      expect(await totals(person.id)).toEqual({ cost: 5, loc: 12 })
      expect((await ts.store.all('SELECT project FROM sessions WHERE trace_id = ?', ['t1']))[0]!.project).toBe('unknown')
      expect(await ts.store.all(`SELECT * FROM spans WHERE project = 'secret'`)).toEqual([])
      expect(await ts.store.memberProjects(person.id)).toEqual([
        { project: 'app', hidden: false, cost: 3 },
        { project: 'secret', hidden: true, cost: 2 },
      ])

      expect(await ts.store.setHiddenProjects(person.id, [])).toBe(true)
      expect(await projectsOf(person.id)).toEqual(['app', 'secret'])
      expect(await totals(person.id)).toEqual({ cost: 5, loc: 12 })
      expect((await ts.store.all('SELECT project FROM sessions WHERE trace_id = ?', ['t1']))[0]!.project).toBe('secret')
      expect((await ts.store.all('SELECT real_project FROM spans WHERE span_id = ?', ['a1']))[0]!.real_project).toBeNull()
    })

    it('hides spans that arrive after the project was hidden, including a resend', async () => {
      ts = await makeStore(backend)
      const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: 'T' })
      await ts.store.setHiddenProjects(person.id, ['secret'])
      await ts.store.ingestSpans(person.id, 'd', spans(), true)
      await ts.store.ingestSpans(person.id, 'd', spans(), true)
      expect(await projectsOf(person.id)).toEqual(['app', 'unknown'])
      expect(await totals(person.id)).toEqual({ cost: 5, loc: 12 })
      await ts.store.setHiddenProjects(person.id, [])
      expect(await projectsOf(person.id)).toEqual(['app', 'secret'])
    })

    it('masks the repo, project filter and PR links of hidden git attribution', async () => {
      ts = await makeStore(backend)
      const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: 'T' })
      await ts.store.ingestSpans(person.id, 'd', spans(), true)
      await ts.store.ingestAttribution(person.id,
        [{ trace_id: 't1', repo: 'acme/secret-repo', project: 'secret', started: now, ended: now, commit_count: 1, pr_links: ['https://git.example/acme/secret-repo/-/merge_requests/1'] }],
        [{ trace_id: 't1', repo: 'acme/secret-repo', sha: 'abcdef1', ts: now, in_main: true, was_reverted: false }])
      const filters = { from: day, to: day }
      expect((await rollup.work(ts.store, filters)).repos.map(r => r.repo)).toEqual(['acme/secret-repo'])

      await ts.store.setHiddenProjects(person.id, ['secret'])
      const hidden = await rollup.work(ts.store, filters)
      expect(JSON.stringify(hidden)).not.toContain('secret')
      expect(hidden.repos).toMatchObject([{ repo: 'unknown', sessions: 1, commits: 1, prs: 0 }])
      expect((await rollup.work(ts.store, { ...filters, project: 'unknown' })).repos).toHaveLength(1)

      await ts.store.setHiddenProjects(person.id, [])
      expect((await rollup.work(ts.store, filters)).repos.map(r => r.repo)).toEqual(['acme/secret-repo'])
    })

    it('rejects empty, overlong and reserved names without changing anything', async () => {
      ts = await makeStore(backend)
      const { person } = await ts.store.addPerson({ name: 'Ann', email: '', team: 'T' })
      expect(await ts.store.setHiddenProjects(person.id, ['ok', ''])).toBe(false)
      expect(await ts.store.setHiddenProjects(person.id, ['unknown'])).toBe(false)
      expect(await ts.store.setHiddenProjects(person.id, ['x'.repeat(129)])).toBe(false)
      expect(await ts.store.all('SELECT * FROM hidden_projects')).toEqual([])
    })

    it('carries hidden projects along on merge and removes them on delete', async () => {
      ts = await makeStore(backend)
      const a = (await ts.store.addPerson({ name: 'A', email: '', team: 'T' })).person
      const b = (await ts.store.addPerson({ name: 'B', email: '', team: 'T' })).person
      await ts.store.ingestSpans(a.id, 'd', spans(), true)
      await ts.store.setHiddenProjects(a.id, ['secret'])
      await ts.store.mergePerson(a.id, b.id)
      expect(await projectsOf(b.id)).toEqual(['app', 'unknown'])
      expect(await ts.store.memberProjects(b.id)).toContainEqual({ project: 'secret', hidden: true, cost: 2 })
      await ts.store.ingestSpans(b.id, 'd', [spanRecord({ span_id: 'n1', ts: now, project: 'secret' })], false)
      expect((await ts.store.all('SELECT project FROM spans WHERE span_id = ?', ['n1']))[0]!.project).toBe('unknown')
      await ts.store.deletePerson(b.id, true)
      expect(await ts.store.all('SELECT * FROM hidden_projects')).toEqual([])
    })
  })

  it('updates a member profile: name, team spelling, and open sessions', async () => {
    ts = await makeStore(backend)
    const a = (await ts.store.addPerson({ name: 'Ann', email: 'a@x.io', team: 'Platform' })).person
    const token = await ts.store.loginSso({ name: 'Ann', role: 'member', personId: a.id, subject: '1' })
    expect(await ts.store.updateProfile(a.id, { name: '  Ann Lee ', team: 'platform' })).toEqual({ name: 'Ann Lee', team: 'Platform' })
    expect(await ts.store.viewerForSession(token)).toMatchObject({ name: 'Ann Lee', role: 'member' })
    expect(await ts.store.updateProfile(a.id, { team: 'New Team' })).toEqual({ name: 'Ann Lee', team: 'New Team' })
    expect(await ts.store.updateProfile(a.id, { name: '   ' })).toEqual({ error: 'invalid_name' })
    expect(await ts.store.updateProfile(a.id, { name: 'a\nb' })).toEqual({ error: 'invalid_name' })
    expect(await ts.store.updateProfile(a.id, { team: '' })).toEqual({ error: 'invalid_team' })
    expect(await ts.store.getPerson(a.id)).toMatchObject({ name: 'Ann Lee', team: 'New Team', email: 'a@x.io' })
    expect(await ts.store.updateProfile('p_nope', { name: 'X' })).toEqual({ error: 'not_found' })
  })
})
