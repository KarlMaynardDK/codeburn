import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../src/team-server/config.js'
import { canonicalTeam, migrate, SCHEMA_VERSION, type SpanRecord } from '../../src/team-server/store.js'
import { toPgSql } from '../../src/team-server/store-postgres.js'
import { BACKENDS, makeStore, type TestStore } from './helpers.js'

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
    expect(loadConfig(dir)).toEqual({ accept_session_detail: false, accept_findings: false, retention_days: 400, org_name: '' })
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
})
