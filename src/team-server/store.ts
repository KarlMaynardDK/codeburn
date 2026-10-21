import { createHash, randomBytes } from 'node:crypto'

export type Row = Record<string, any>

/** Query runner. SQL uses `?` placeholders; the PostgreSQL adapter translates them. */
export interface Querier {
  all(sql: string, params?: unknown[]): Promise<Row[]>
}

/** Backend adapter implemented by store-sqlite.ts and store-postgres.ts. */
export interface Db extends Querier {
  readonly kind: 'sqlite' | 'postgres'
  tx<T>(fn: (q: Querier) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function newSecret(prefix: 'cbe_' | 'cbd_' | 'cbv_' | 'cbs_'): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function newId(prefix: string): string {
  return prefix + randomBytes(8).toString('hex')
}

export const SCHEMA_VERSION = 1

/** Portable DDL with backend-specific numeric types. */
export function schemaStatements(real: string, int: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS schema_version (version ${int} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, team TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, cred_hash TEXT NOT NULL UNIQUE, label TEXT, client_device_id TEXT, created_at TEXT NOT NULL, last_seen TEXT, revoked_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS enrollments (token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS viewers (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS viewer_sessions (token_hash TEXT PRIMARY KEY, viewer_id TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS spans (span_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, device_id TEXT NOT NULL, trace_id TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL, category TEXT NOT NULL, input ${int} NOT NULL, output ${int} NOT NULL, cache_read ${int} NOT NULL, cache_write ${int} NOT NULL, cost_usd ${real} NOT NULL, detail_level TEXT NOT NULL, work_unit_id TEXT, session_role TEXT, call_count ${int}, session_duration_ms ${int})`,
    `CREATE INDEX IF NOT EXISTS spans_person_day ON spans (person_id, day)`,
    `CREATE INDEX IF NOT EXISTS spans_trace ON spans (person_id, trace_id)`,
    `CREATE TABLE IF NOT EXISTS daily_usage (person_id TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL, category TEXT NOT NULL, input ${int} NOT NULL, output ${int} NOT NULL, cache_read ${int} NOT NULL, cache_write ${int} NOT NULL, cost_usd ${real} NOT NULL, calls ${int} NOT NULL, PRIMARY KEY (person_id, day, provider, model, project, category))`,
    `CREATE INDEX IF NOT EXISTS daily_usage_day ON daily_usage (day)`,
    `CREATE TABLE IF NOT EXISTS sessions (trace_id TEXT NOT NULL, person_id TEXT NOT NULL, project TEXT NOT NULL, started TEXT NOT NULL, duration_ms ${int} NOT NULL, calls ${int} NOT NULL, cost ${real} NOT NULL, PRIMARY KEY (person_id, trace_id))`,
    `CREATE TABLE IF NOT EXISTS findings (person_id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, json TEXT NOT NULL)`,
  ]
}

export async function migrate(db: Db): Promise<void> {
  const real = db.kind === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'
  const int = db.kind === 'postgres' ? 'BIGINT' : 'INTEGER'
  await db.tx(async q => {
    if (db.kind === 'postgres') await q.all('SELECT pg_advisory_xact_lock(7203)')
    for (const stmt of schemaStatements(real, int)) await q.all(stmt)
    const v = await q.all('SELECT version FROM schema_version')
    if (v.length === 0) await q.all('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION])
  })
}

export interface Person { id: string; name: string; email: string; team: string; revoked_at: string | null }

export interface SpanRecord {
  span_id: string
  trace_id: string
  ts: string
  provider: string
  model: string
  project: string
  category: string
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost_usd: number
  detail_level: 'summary' | 'sessions'
  work_unit_id: string | null
  session_role: string | null
  call_count: number | null
  session_duration_ms: number | null
}

const nowIso = () => new Date().toISOString()
const WEEK_MS = 7 * 86_400_000

/**
 * All persistence operations. One implementation over the portable `Db` adapter;
 * backend differences (placeholders, numeric types, transactions) live in the adapters.
 */
export class Store {
  constructor(readonly db: Db) {}

  all(sql: string, params: unknown[] = []): Promise<Row[]> { return this.db.all(sql, params) }
  close(): Promise<void> { return this.db.close() }

  // ---- people / enrollment ----

  async addPerson(p: { name: string; email: string; team: string }, tokenTtlMs = WEEK_MS): Promise<{ person: Person; enrollmentToken: string }> {
    const id = newId('p_')
    await this.all('INSERT INTO people (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)', [id, p.name, p.email, p.team, nowIso()])
    const enrollmentToken = await this.createEnrollment(id, tokenTtlMs)
    return { person: { id, ...p, revoked_at: null }, enrollmentToken }
  }

  async createEnrollment(personId: string, ttlMs = WEEK_MS): Promise<string> {
    const token = newSecret('cbe_')
    await this.all('INSERT INTO enrollments (token_hash, person_id, expires_at) VALUES (?, ?, ?)',
      [sha256hex(token), personId, new Date(Date.now() + ttlMs).toISOString()])
    return token
  }

  /** Invalidates unused enrollment tokens and issues a fresh one. Null when the person is unknown or revoked. */
  async rotateEnrollment(personId: string, ttlMs?: number): Promise<string | null> {
    const rows = await this.all('SELECT id FROM people WHERE id = ? AND revoked_at IS NULL', [personId])
    if (rows.length === 0) return null
    await this.all('DELETE FROM enrollments WHERE person_id = ? AND used_at IS NULL', [personId])
    return this.createEnrollment(personId, ttlMs)
  }

  /** Atomically consumes a one-time token and mints a device credential. */
  async enroll(token: string, label: string | null, clientDeviceId: string | null): Promise<{ credential: string; device_id: string; person: { name: string; email: string } } | null> {
    const now = nowIso()
    return this.db.tx(async q => {
      const used = await q.all(
        `UPDATE enrollments SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
         AND person_id IN (SELECT id FROM people WHERE revoked_at IS NULL) RETURNING person_id`,
        [now, sha256hex(token), now])
      if (used.length === 0) return null
      const personId = used[0]!.person_id as string
      const credential = newSecret('cbd_')
      const deviceId = newId('d_')
      await q.all('INSERT INTO devices (id, person_id, cred_hash, label, client_device_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [deviceId, personId, sha256hex(credential), label, clientDeviceId, now, now])
      const person = (await q.all('SELECT name, email FROM people WHERE id = ?', [personId]))[0]!
      return { credential, device_id: deviceId, person: { name: person.name as string, email: person.email as string } }
    })
  }

  async authenticateDevice(credential: string): Promise<{ deviceId: string; personId: string } | null> {
    if (!credential.startsWith('cbd_')) return null
    const rows = await this.all(
      `SELECT d.id AS device_id, d.person_id AS person_id FROM devices d JOIN people p ON p.id = d.person_id
       WHERE d.cred_hash = ? AND d.revoked_at IS NULL AND p.revoked_at IS NULL`, [sha256hex(credential)])
    if (rows.length === 0) return null
    await this.all('UPDATE devices SET last_seen = ? WHERE id = ?', [nowIso(), rows[0]!.device_id])
    return { deviceId: rows[0]!.device_id as string, personId: rows[0]!.person_id as string }
  }

  async listPeople(): Promise<Array<Person & { devices: Array<{ id: string; label: string | null; last_seen: string | null; revoked_at: string | null }> }>> {
    const people = await this.all('SELECT id, name, email, team, revoked_at FROM people ORDER BY created_at, id')
    const devices = await this.all('SELECT id, person_id, label, last_seen, revoked_at FROM devices ORDER BY created_at, id')
    return people.map(p => ({
      id: p.id, name: p.name, email: p.email, team: p.team, revoked_at: p.revoked_at ?? null,
      devices: devices.filter(d => d.person_id === p.id).map(d => ({ id: d.id, label: d.label ?? null, last_seen: d.last_seen ?? null, revoked_at: d.revoked_at ?? null })),
    }))
  }

  /** Revokes a person (and implicitly all their devices) or a single device. */
  async revoke(id: string): Promise<'person' | 'device' | null> {
    const now = nowIso()
    const p = await this.all('UPDATE people SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id', [now, id])
    if (p.length > 0) {
      await this.all('DELETE FROM enrollments WHERE person_id = ? AND used_at IS NULL', [id])
      return 'person'
    }
    const d = await this.all('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id', [now, id])
    return d.length > 0 ? 'device' : null
  }

  // ---- viewers ----

  async addViewer(name: string): Promise<{ id: string; key: string }> {
    const key = newSecret('cbv_')
    const id = newId('v_')
    await this.all('INSERT INTO viewers (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)', [id, name, sha256hex(key), nowIso()])
    return { id, key }
  }

  async loginViewer(key: string): Promise<{ token: string; name: string } | null> {
    const rows = await this.all('SELECT id, name FROM viewers WHERE key_hash = ? AND revoked_at IS NULL', [sha256hex(key)])
    if (rows.length === 0) return null
    const token = newSecret('cbs_')
    await this.all('INSERT INTO viewer_sessions (token_hash, viewer_id, expires_at) VALUES (?, ?, ?)',
      [sha256hex(token), rows[0]!.id, new Date(Date.now() + 12 * 3600_000).toISOString()])
    return { token, name: rows[0]!.name as string }
  }

  async viewerForSession(token: string): Promise<{ name: string } | null> {
    const rows = await this.all(
      `SELECT v.name AS name FROM viewer_sessions s JOIN viewers v ON v.id = s.viewer_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND v.revoked_at IS NULL`, [sha256hex(token), nowIso()])
    return rows.length > 0 ? { name: rows[0]!.name as string } : null
  }

  async logoutViewer(token: string): Promise<void> {
    await this.all('DELETE FROM viewer_sessions WHERE token_hash = ?', [sha256hex(token)])
  }

  // ---- ingest ----

  /**
   * Upserts spans for a person, then recomputes daily_usage for each affected day (and sessions for
   * affected traces when `withSessions`). A span_id owned by another person is skipped, never reassigned.
   */
  async ingestSpans(personId: string, deviceId: string, spans: SpanRecord[], withSessions: boolean): Promise<{ stored: number; conflicts: number }> {
    if (spans.length === 0) return { stored: 0, conflicts: 0 }
    return this.db.tx(async q => {
      const days = new Set<string>()
      const traces = new Set<string>()
      const existing = new Map<string, { person_id: string; day: string; trace_id: string }>()
      const ids = [...new Set(spans.map(s => s.span_id))]
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200)
        const rows = await q.all(`SELECT span_id, person_id, day, trace_id FROM spans WHERE span_id IN (${chunk.map(() => '?').join(',')})`, chunk)
        for (const r of rows) existing.set(r.span_id, { person_id: r.person_id, day: r.day, trace_id: r.trace_id })
      }
      let stored = 0
      let conflicts = 0
      for (const s of spans) {
        const prev = existing.get(s.span_id)
        if (prev && prev.person_id !== personId) { conflicts++; continue }
        if (prev) { days.add(prev.day); traces.add(prev.trace_id) }
        const day = s.ts.slice(0, 10)
        days.add(day)
        traces.add(s.trace_id)
        await q.all(
          `INSERT INTO spans (span_id, person_id, device_id, trace_id, ts, day, provider, model, project, category, input, output, cache_read, cache_write, cost_usd, detail_level, work_unit_id, session_role, call_count, session_duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (span_id) DO UPDATE SET device_id = excluded.device_id, trace_id = excluded.trace_id, ts = excluded.ts, day = excluded.day,
             provider = excluded.provider, model = excluded.model, project = excluded.project, category = excluded.category,
             input = excluded.input, output = excluded.output, cache_read = excluded.cache_read, cache_write = excluded.cache_write,
             cost_usd = excluded.cost_usd, detail_level = excluded.detail_level, work_unit_id = excluded.work_unit_id,
             session_role = excluded.session_role, call_count = excluded.call_count, session_duration_ms = excluded.session_duration_ms
           WHERE spans.person_id = excluded.person_id`,
          [s.span_id, personId, deviceId, s.trace_id, s.ts, day, s.provider, s.model, s.project, s.category, s.input, s.output,
            s.cache_read, s.cache_write, s.cost_usd, s.detail_level, s.work_unit_id, s.session_role, s.call_count, s.session_duration_ms])
        stored++
      }
      for (const day of days) {
        await q.all('DELETE FROM daily_usage WHERE person_id = ? AND day = ?', [personId, day])
        await q.all(
          `INSERT INTO daily_usage (person_id, day, provider, model, project, category, input, output, cache_read, cache_write, cost_usd, calls)
           SELECT person_id, day, provider, model, project, category, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cost_usd), COUNT(*)
           FROM spans WHERE person_id = ? AND day = ? GROUP BY person_id, day, provider, model, project, category`, [personId, day])
      }
      if (withSessions) {
        for (const trace of traces) {
          await q.all('DELETE FROM sessions WHERE person_id = ? AND trace_id = ?', [personId, trace])
          await q.all(
            `INSERT INTO sessions (trace_id, person_id, project, started, duration_ms, calls, cost)
             SELECT trace_id, person_id, MAX(project), MIN(ts), COALESCE(MAX(session_duration_ms), 0), COUNT(*), SUM(cost_usd)
             FROM spans WHERE person_id = ? AND trace_id = ? AND detail_level = 'sessions' GROUP BY trace_id, person_id`, [personId, trace])
        }
      }
      return { stored, conflicts }
    })
  }

  async saveFindings(personId: string, capturedAt: string, json: string): Promise<void> {
    await this.all(
      `INSERT INTO findings (person_id, captured_at, json) VALUES (?, ?, ?)
       ON CONFLICT (person_id) DO UPDATE SET captured_at = excluded.captured_at, json = excluded.json`, [personId, capturedAt, json])
  }

  // ---- retention ----

  async prune(retentionDays: number, now = new Date()): Promise<{ spans: number }> {
    const cutoffTs = new Date(now.getTime() - retentionDays * 86_400_000)
    const cutoffDay = cutoffTs.toISOString().slice(0, 10)
    const cutoff = cutoffTs.toISOString()
    return this.db.tx(async q => {
      const del = await q.all('DELETE FROM spans WHERE day < ? RETURNING span_id', [cutoffDay])
      await q.all('DELETE FROM daily_usage WHERE day < ?', [cutoffDay])
      await q.all('DELETE FROM sessions WHERE started < ?', [cutoff])
      await q.all('DELETE FROM viewer_sessions WHERE expires_at < ?', [now.toISOString()])
      await q.all('DELETE FROM enrollments WHERE expires_at < ? AND used_at IS NULL', [cutoff])
      return { spans: del.length }
    })
  }
}
