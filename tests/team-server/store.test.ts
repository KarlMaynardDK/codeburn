import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../src/team-server/config.js'
import { migrate } from '../../src/team-server/store.js'
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
    expect(await ts.store.viewerForSession(login!.token)).toEqual({ name: 'Boss' })
    await ts.store.all('UPDATE viewer_sessions SET expires_at = ?', ['2001-01-01T00:00:00.000Z'])
    expect(await ts.store.viewerForSession(login!.token)).toBeNull()
    await ts.store.prune(400)
    expect(await ts.store.all('SELECT * FROM viewer_sessions')).toEqual([])
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
