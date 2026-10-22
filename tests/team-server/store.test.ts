import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../src/team-server/config.js'
import { canonicalTeam, migrate } from '../../src/team-server/store.js'
import { toPgSql } from '../../src/team-server/store-postgres.js'
import { BACKENDS, makeStore, type TestStore } from './helpers.js'

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
    expect(await ts.store.all('SELECT version FROM schema_version')).toEqual([{ version: 1 }])
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
    const bad = { span_id: 'x', trace_id: 't', ts: new Date().toISOString(), provider: 'p', model: 'm', project: 'p', category: 'c', input: 1, output: 1, cache_read: 0, cache_write: 0, cost_usd: 1, detail_level: 'summary' as const, work_unit_id: null, session_role: null, call_count: null, session_duration_ms: null }
    await expect(ts.store.ingestSpans(person.id, 'd', [bad, { ...bad, span_id: 'y', model: null as unknown as string }], false)).rejects.toThrow()
    expect(await ts.store.all('SELECT * FROM spans')).toEqual([])
    expect(await ts.store.all('SELECT * FROM daily_usage')).toEqual([])
  })
})
