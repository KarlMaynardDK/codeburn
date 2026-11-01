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

export const SCHEMA_VERSION = 3

/**
 * Span columns added in schema v2, with their defaults. Spans stored before v2 read as zero, empty or
 * (request_weight) one, which is exactly what an older client meant by leaving the attribute out.
 */
function spanV2Columns(real: string, int: string): string[] {
  return [
    `speed TEXT NOT NULL DEFAULT 'unknown'`, `route TEXT NOT NULL DEFAULT ''`, `billing TEXT NOT NULL DEFAULT ''`,
    `cost_estimated ${int} NOT NULL DEFAULT 0`, `subscription_covered ${int} NOT NULL DEFAULT 0`,
    `reasoning ${int} NOT NULL DEFAULT 0`, `web_search ${int} NOT NULL DEFAULT 0`, `cache_write_1h ${int} NOT NULL DEFAULT 0`,
    `savings_usd ${real} NOT NULL DEFAULT 0`, `nano_aiu ${int} NOT NULL DEFAULT 0`, `request_weight ${int} NOT NULL DEFAULT 1`,
    `lines_added ${int} NOT NULL DEFAULT 0`, `lines_removed ${int} NOT NULL DEFAULT 0`, `tool_errors ${int} NOT NULL DEFAULT 0`,
    `interrupted ${int} NOT NULL DEFAULT 0`, `user_modified ${int} NOT NULL DEFAULT 0`,
    `active_ms ${int} NOT NULL DEFAULT 0`, `tool_wait_ms ${int} NOT NULL DEFAULT 0`,
    `turn_start ${int} NOT NULL DEFAULT 0`, `turn_has_edits ${int} NOT NULL DEFAULT 0`, `turn_retries ${int} NOT NULL DEFAULT 0`,
    `plan_mode ${int} NOT NULL DEFAULT 0`,
    `mcp_tools TEXT NOT NULL DEFAULT ''`, `skills TEXT NOT NULL DEFAULT ''`, `subagent_types TEXT NOT NULL DEFAULT ''`,
  ]
}

/** daily_usage is derived from spans, so a schema change drops and rebuilds it. */
function dailyUsageTable(real: string, int: string): string {
  const sums = ['input', 'output', 'reasoning', 'cache_read', 'cache_write', 'cache_write_1h', 'web_search'].map(c => `${c} ${int} NOT NULL`)
  const costs = ['cost_usd', 'estimated_cost_usd', 'covered_cost_usd', 'savings_usd'].map(c => `${c} ${real} NOT NULL`)
  const counts = ['nano_aiu', 'calls', 'lines_added', 'lines_removed', 'tool_errors', 'interrupted', 'user_modified', 'active_ms',
    'tool_wait_ms', 'turns', 'edit_turns', 'one_shot_turns', 'retries', 'plan_mode_calls'].map(c => `${c} ${int} NOT NULL`)
  return `CREATE TABLE IF NOT EXISTS daily_usage (person_id TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL, category TEXT NOT NULL, speed TEXT NOT NULL, route TEXT NOT NULL, billing TEXT NOT NULL, ${[...sums, ...costs, ...counts].join(', ')}, PRIMARY KEY (person_id, day, provider, model, project, category, speed, route, billing))`
}

/** Rolls spans up into daily_usage. `where` narrows the spans (empty for a full rebuild). */
function dailyUsageInsert(where: string): string {
  return `INSERT INTO daily_usage (person_id, day, provider, model, project, category, speed, route, billing, input, output, reasoning, cache_read, cache_write, cache_write_1h, web_search, cost_usd, estimated_cost_usd, covered_cost_usd, savings_usd, nano_aiu, calls, lines_added, lines_removed, tool_errors, interrupted, user_modified, active_ms, tool_wait_ms, turns, edit_turns, one_shot_turns, retries, plan_mode_calls)
    SELECT person_id, day, provider, model, project, category, speed, route, billing,
      SUM(input), SUM(output), SUM(reasoning), SUM(cache_read), SUM(cache_write), SUM(cache_write_1h), SUM(web_search), SUM(cost_usd),
      SUM(CASE WHEN cost_estimated = 1 THEN cost_usd ELSE 0 END), SUM(CASE WHEN subscription_covered = 1 THEN cost_usd ELSE 0 END),
      SUM(savings_usd), SUM(nano_aiu), SUM(request_weight), SUM(lines_added), SUM(lines_removed), SUM(tool_errors), SUM(interrupted),
      SUM(user_modified), SUM(active_ms), SUM(tool_wait_ms), SUM(turn_start), SUM(turn_start * turn_has_edits),
      SUM(CASE WHEN turn_start = 1 AND turn_has_edits = 1 AND turn_retries = 0 THEN 1 ELSE 0 END),
      SUM(turn_start * turn_has_edits * turn_retries), SUM(plan_mode)
    FROM spans ${where} GROUP BY person_id, day, provider, model, project, category, speed, route, billing`
}

/** Statements that move a v1 database to v2. Tables new in v2 come from schemaStatements. */
function migrationV2(real: string, int: string): string[] {
  return [
    ...spanV2Columns(real, int).map(col => `ALTER TABLE spans ADD COLUMN ${col}`),
    `ALTER TABLE devices ADD COLUMN coverage_through TEXT`,
    `DROP TABLE daily_usage`,
    dailyUsageTable(real, int),
    `CREATE INDEX IF NOT EXISTS daily_usage_day ON daily_usage (day)`,
    dailyUsageInsert(''),
  ]
}

/** Statements that move a v2 database to v3: the CLI version each device last reported. */
function migrationV3(): string[] {
  return [`ALTER TABLE devices ADD COLUMN client_version TEXT`]
}

/** Portable DDL with backend-specific numeric types, in the current (v3) shape. */
export function schemaStatements(real: string, int: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS schema_version (version ${int} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, team TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, cred_hash TEXT NOT NULL UNIQUE, label TEXT, client_device_id TEXT, created_at TEXT NOT NULL, last_seen TEXT, revoked_at TEXT, coverage_through TEXT, client_version TEXT)`,
    `CREATE TABLE IF NOT EXISTS enrollments (token_hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS viewers (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT)`,
    `CREATE TABLE IF NOT EXISTS viewer_sessions (token_hash TEXT PRIMARY KEY, viewer_id TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sso_sessions (token_hash TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, person_id TEXT, subject TEXT NOT NULL, email TEXT, expires_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS spans (span_id TEXT PRIMARY KEY, person_id TEXT NOT NULL, device_id TEXT NOT NULL, trace_id TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, project TEXT NOT NULL, category TEXT NOT NULL, input ${int} NOT NULL, output ${int} NOT NULL, cache_read ${int} NOT NULL, cache_write ${int} NOT NULL, cost_usd ${real} NOT NULL, detail_level TEXT NOT NULL, work_unit_id TEXT, session_role TEXT, call_count ${int}, session_duration_ms ${int}, ${spanV2Columns(real, int).join(', ')})`,
    `CREATE INDEX IF NOT EXISTS spans_person_day ON spans (person_id, day)`,
    `CREATE INDEX IF NOT EXISTS spans_trace ON spans (person_id, trace_id)`,
    dailyUsageTable(real, int),
    `CREATE INDEX IF NOT EXISTS daily_usage_day ON daily_usage (day)`,
    // MCP tools, skills and subagent types per day; cost is the spend of the calls that used the name.
    `CREATE TABLE IF NOT EXISTS daily_names (person_id TEXT NOT NULL, day TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, calls ${int} NOT NULL, cost_usd ${real} NOT NULL, PRIMARY KEY (person_id, day, project, kind, name))`,
    `CREATE INDEX IF NOT EXISTS daily_names_day ON daily_names (day)`,
    `CREATE TABLE IF NOT EXISTS sessions (trace_id TEXT NOT NULL, person_id TEXT NOT NULL, project TEXT NOT NULL, started TEXT NOT NULL, duration_ms ${int} NOT NULL, calls ${int} NOT NULL, cost ${real} NOT NULL, PRIMARY KEY (person_id, trace_id))`,
    `CREATE TABLE IF NOT EXISTS findings (person_id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, json TEXT NOT NULL)`,
    // Git attribution (`codeburn sync push --attribution`): which repo and PRs a session worked on, and its commits.
    `CREATE TABLE IF NOT EXISTS work_sessions (person_id TEXT NOT NULL, trace_id TEXT NOT NULL, repo TEXT NOT NULL, project TEXT NOT NULL, started TEXT NOT NULL, ended TEXT NOT NULL, commit_count ${int} NOT NULL, pr_links TEXT NOT NULL, PRIMARY KEY (person_id, trace_id))`,
    `CREATE TABLE IF NOT EXISTS work_commits (person_id TEXT NOT NULL, trace_id TEXT NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL, ts TEXT NOT NULL, in_main ${int} NOT NULL, was_reverted ${int} NOT NULL, PRIMARY KEY (person_id, trace_id, sha))`,
  ]
}

export async function migrate(db: Db): Promise<void> {
  const real = db.kind === 'postgres' ? 'DOUBLE PRECISION' : 'REAL'
  const int = db.kind === 'postgres' ? 'BIGINT' : 'INTEGER'
  await db.tx(async q => {
    if (db.kind === 'postgres') await q.all('SELECT pg_advisory_xact_lock(7203)')
    // Read the version before creating anything: on a v1 database the CREATE IF NOT EXISTS below skips the old tables.
    const hasVersionTable = db.kind === 'postgres'
      ? (await q.all(`SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'schema_version'`)).length > 0
      : (await q.all(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)).length > 0
    const stored = hasVersionTable ? (await q.all('SELECT version FROM schema_version'))[0] : undefined
    const from = stored ? Number(stored.version) : SCHEMA_VERSION
    if (from > SCHEMA_VERSION) throw new Error(`team-server: database schema v${from} is newer than this server (v${SCHEMA_VERSION}); upgrade codeburn`)
    for (const stmt of schemaStatements(real, int)) await q.all(stmt)
    if (from < 2) for (const stmt of migrationV2(real, int)) await q.all(stmt)
    if (from < 3) for (const stmt of migrationV3()) await q.all(stmt)
    if (!stored) await q.all('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION])
    else if (from < SCHEMA_VERSION) await q.all('UPDATE schema_version SET version = ?', [SCHEMA_VERSION])
  })
}

export interface Person { id: string; name: string; email: string; team: string; revoked_at: string | null }

/** A signed-in viewer. Viewer keys and GitLab admins see everything; members see only their own person. */
export type Viewer =
  | { name: string; role: 'admin' }
  | { name: string; role: 'member'; personId: string }
  | { name: string; role: 'registrant'; email: string }

export const TEAM_MAX_LENGTH = 64

/**
 * Validates a self-registered team name and reuses an existing team's spelling when the input differs only in
 * letter case or surrounding spaces. Null when the name is empty, too long or has control characters.
 */
export function canonicalTeam(input: string, existing: string[]): string | null {
  const team = input.trim()
  // eslint-disable-next-line no-control-regex
  if (!team || team.length > TEAM_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(team)) return null
  const key = team.toLowerCase()
  return existing.find(t => t.trim().toLowerCase() === key) ?? team
}

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
  speed: string
  /** Billing route id; empty for a direct call. */
  route: string
  /** 'metered', 'subscription', or empty when unknown. */
  billing: string
  cost_estimated: boolean
  subscription_covered: boolean
  reasoning: number
  web_search: number
  cache_write_1h: number
  savings_usd: number
  nano_aiu: number
  /** Requests this span stands for: 0 for supplementary accounting, N for a daily aggregate, else 1. */
  request_weight: number
  lines_added: number
  lines_removed: number
  tool_errors: number
  interrupted: boolean
  user_modified: boolean
  active_ms: number
  tool_wait_ms: number
  turn_start: boolean
  turn_has_edits: boolean
  turn_retries: number
  plan_mode: boolean
  mcp_tools: string[]
  skills: string[]
  subagent_types: string[]
}

/** One `codeburn.session.attribution` span: the repo, PR links and commit count of a session. */
export interface WorkSessionRecord {
  trace_id: string
  repo: string
  project: string
  started: string
  ended: string
  commit_count: number
  pr_links: string[]
}

/** One `codeburn.commit` span. */
export interface WorkCommitRecord {
  trace_id: string
  repo: string
  sha: string
  ts: string
  in_main: boolean
  was_reverted: boolean
}

/** spans columns in insert order, after span_id, person_id and device_id. */
const SPAN_COLUMNS = [
  'trace_id', 'ts', 'day', 'provider', 'model', 'project', 'category', 'input', 'output', 'cache_read', 'cache_write', 'cost_usd',
  'detail_level', 'work_unit_id', 'session_role', 'call_count', 'session_duration_ms', 'speed', 'route', 'billing', 'cost_estimated',
  'subscription_covered', 'reasoning', 'web_search', 'cache_write_1h', 'savings_usd', 'nano_aiu', 'request_weight', 'lines_added',
  'lines_removed', 'tool_errors', 'interrupted', 'user_modified', 'active_ms', 'tool_wait_ms', 'turn_start', 'turn_has_edits',
  'turn_retries', 'plan_mode', 'mcp_tools', 'skills', 'subagent_types',
] as const

const bit = (b: boolean) => (b ? 1 : 0)
const nameList = (names: string[]) => (names.length > 0 ? JSON.stringify(names) : '')

function spanValues(s: SpanRecord, day: string): unknown[] {
  return [
    s.trace_id, s.ts, day, s.provider, s.model, s.project, s.category, s.input, s.output, s.cache_read, s.cache_write, s.cost_usd,
    s.detail_level, s.work_unit_id, s.session_role, s.call_count, s.session_duration_ms, s.speed, s.route, s.billing, bit(s.cost_estimated),
    bit(s.subscription_covered), s.reasoning, s.web_search, s.cache_write_1h, s.savings_usd, s.nano_aiu, s.request_weight, s.lines_added,
    s.lines_removed, s.tool_errors, bit(s.interrupted), bit(s.user_modified), s.active_ms, s.tool_wait_ms, bit(s.turn_start), bit(s.turn_has_edits),
    s.turn_retries, bit(s.plan_mode), nameList(s.mcp_tools), nameList(s.skills), nameList(s.subagent_types),
  ]
}

const NAME_KINDS = [['mcp_tools', 'mcp'], ['skills', 'skill'], ['subagent_types', 'subagent']] as const

function parseNames(json: unknown): string[] {
  if (typeof json !== 'string' || !json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const nowIso = () => new Date().toISOString()
const WEEK_MS = 7 * 86_400_000
const SESSION_TTL_MS = 12 * 3600_000

type RegisterError = 'not_registrant' | 'invalid_team' | 'email_taken'
class RegisterFailure extends Error {
  constructor(readonly code: RegisterError) { super(code) }
}

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

  async peopleByEmail(email: string): Promise<Array<{ id: string; revoked_at: string | null }>> {
    const rows = await this.all('SELECT id, revoked_at FROM people WHERE lower(email) = ?', [email.trim().toLowerCase()])
    return rows.map(r => ({ id: r.id as string, revoked_at: r.revoked_at ?? null }))
  }

  /** Team names in use by active people, sorted. */
  async distinctTeams(): Promise<string[]> {
    const rows = await this.all(`SELECT DISTINCT team FROM people WHERE revoked_at IS NULL AND team <> '' ORDER BY team`)
    return rows.map(r => r.team as string)
  }

  async getPerson(id: string): Promise<Person | null> {
    const r = (await this.all('SELECT id, name, email, team, revoked_at FROM people WHERE id = ?', [id]))[0]
    return r ? { id: r.id, name: r.name, email: r.email, team: r.team, revoked_at: r.revoked_at ?? null } : null
  }

  /**
   * Turns a registrant session into a person with a fresh enrollment token, and upgrades the session to member.
   * Atomic: a double submit or a concurrent registration for the same email cannot create two people.
   */
  async registerSelf(sessionToken: string, teamInput: string, ttlMs = WEEK_MS):
    Promise<{ person: Person; enrollmentToken: string; expiresAt: string } | { error: RegisterError }> {
    const now = nowIso()
    try {
      return await this.db.tx(async q => {
        if (this.db.kind === 'postgres') await q.all('SELECT pg_advisory_xact_lock(7204)')
        const id = newId('p_')
        // Claiming the session first serialises a double submit on the same session.
        const claimed = await q.all(
          `UPDATE sso_sessions SET role = 'member', person_id = ?
           WHERE token_hash = ? AND role = 'registrant' AND expires_at > ? RETURNING name, email`, [id, sha256hex(sessionToken), now])
        if (claimed.length === 0) throw new RegisterFailure('not_registrant')
        const name = claimed[0]!.name as string
        const email = claimed[0]!.email as string
        const teams = (await q.all(`SELECT DISTINCT team FROM people WHERE revoked_at IS NULL AND team <> ''`)).map(r => r.team as string)
        const team = canonicalTeam(teamInput, teams)
        if (!team) throw new RegisterFailure('invalid_team')
        if ((await q.all('SELECT id FROM people WHERE lower(email) = ?', [email.toLowerCase()])).length > 0) throw new RegisterFailure('email_taken')
        await q.all('INSERT INTO people (id, name, email, team, created_at) VALUES (?, ?, ?, ?, ?)', [id, name, email, team, now])
        const enrollmentToken = newSecret('cbe_')
        const expiresAt = new Date(Date.now() + ttlMs).toISOString()
        await q.all('INSERT INTO enrollments (token_hash, person_id, expires_at) VALUES (?, ?, ?)', [sha256hex(enrollmentToken), id, expiresAt])
        await q.all('UPDATE sso_sessions SET email = NULL WHERE token_hash = ?', [sha256hex(sessionToken)])
        return { person: { id, name, email, team, revoked_at: null }, enrollmentToken, expiresAt }
      })
    } catch (err) {
      if (err instanceof RegisterFailure) return { error: err.code }
      throw err
    }
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

  /** Authenticates a device credential and stamps last_seen, plus the CLI version the device reports (when it sends one). */
  async authenticateDevice(credential: string, clientVersion?: string | null): Promise<{ deviceId: string; personId: string } | null> {
    if (!credential.startsWith('cbd_')) return null
    const rows = await this.all(
      `SELECT d.id AS device_id, d.person_id AS person_id FROM devices d JOIN people p ON p.id = d.person_id
       WHERE d.cred_hash = ? AND d.revoked_at IS NULL AND p.revoked_at IS NULL`, [sha256hex(credential)])
    if (rows.length === 0) return null
    if (clientVersion) await this.all('UPDATE devices SET last_seen = ?, client_version = ? WHERE id = ?', [nowIso(), clientVersion, rows[0]!.device_id])
    else await this.all('UPDATE devices SET last_seen = ? WHERE id = ?', [nowIso(), rows[0]!.device_id])
    return { deviceId: rows[0]!.device_id as string, personId: rows[0]!.person_id as string }
  }

  async listPeople(): Promise<Array<Person & { devices: Array<{ id: string; label: string | null; last_seen: string | null; revoked_at: string | null; client_version: string | null }> }>> {
    const people = await this.all('SELECT id, name, email, team, revoked_at FROM people ORDER BY created_at, id')
    const devices = await this.all('SELECT id, person_id, label, last_seen, revoked_at, client_version FROM devices ORDER BY created_at, id')
    return people.map(p => ({
      id: p.id, name: p.name, email: p.email, team: p.team, revoked_at: p.revoked_at ?? null,
      devices: devices.filter(d => d.person_id === p.id).map(d => ({ id: d.id, label: d.label ?? null, last_seen: d.last_seen ?? null, revoked_at: d.revoked_at ?? null, client_version: d.client_version ?? null })),
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

  /**
   * Moves everything one person owns (spans and their rollups, sessions, git attribution, devices, viewer
   * sessions, findings) onto another, then revokes the source person so its email can't register again.
   * Span ids are unique across people, so the move can't collide; per-person keys that could (sessions,
   * attribution, findings) keep the target's row. Returns null when either person is unknown, the same, or
   * the target is revoked.
   */
  async mergePerson(fromId: string, toId: string): Promise<{ spans: number; devices: number; days: number } | null> {
    if (fromId === toId) return null
    const found = await this.all('SELECT id, revoked_at FROM people WHERE id IN (?, ?)', [fromId, toId])
    const from = found.find(r => r.id === fromId)
    const to = found.find(r => r.id === toId)
    if (!from || !to || to.revoked_at) return null
    return this.db.tx(async q => {
      const dayRows = await q.all('SELECT DISTINCT day FROM spans WHERE person_id = ?', [fromId])
      const days = dayRows.map(r => String(r.day))
      const traceRows = await q.all('SELECT DISTINCT trace_id FROM spans WHERE person_id = ?', [fromId])
      const moved = await q.all('UPDATE spans SET person_id = ? WHERE person_id = ? RETURNING span_id', [toId, fromId])
      // Rollups are derived from spans, so drop the source's and rebuild the target's affected days.
      await q.all('DELETE FROM daily_usage WHERE person_id = ?', [fromId])
      await q.all('DELETE FROM daily_names WHERE person_id = ?', [fromId])
      for (const day of days) {
        await q.all('DELETE FROM daily_usage WHERE person_id = ? AND day = ?', [toId, day])
        await q.all(dailyUsageInsert('WHERE person_id = ? AND day = ?'), [toId, day])
        await this.rebuildDailyNames(q, toId, day)
      }
      await q.all('DELETE FROM sessions WHERE person_id = ?', [fromId])
      for (const t of traceRows) {
        const trace = String(t.trace_id)
        await q.all('DELETE FROM sessions WHERE person_id = ? AND trace_id = ?', [toId, trace])
        await q.all(
          `INSERT INTO sessions (trace_id, person_id, project, started, duration_ms, calls, cost)
           SELECT trace_id, person_id, MAX(project), MIN(ts), COALESCE(MAX(session_duration_ms), 0), SUM(request_weight), SUM(cost_usd)
           FROM spans WHERE person_id = ? AND trace_id = ? AND detail_level = 'sessions' GROUP BY trace_id, person_id`, [toId, trace])
      }
      await q.all(
        `INSERT INTO work_sessions (person_id, trace_id, repo, project, started, ended, commit_count, pr_links)
         SELECT ?, trace_id, repo, project, started, ended, commit_count, pr_links FROM work_sessions WHERE person_id = ? AND 1=1
         ON CONFLICT (person_id, trace_id) DO NOTHING`, [toId, fromId])
      await q.all('DELETE FROM work_sessions WHERE person_id = ?', [fromId])
      await q.all(
        `INSERT INTO work_commits (person_id, trace_id, repo, sha, ts, in_main, was_reverted)
         SELECT ?, trace_id, repo, sha, ts, in_main, was_reverted FROM work_commits WHERE person_id = ? AND 1=1
         ON CONFLICT (person_id, trace_id, sha) DO NOTHING`, [toId, fromId])
      await q.all('DELETE FROM work_commits WHERE person_id = ?', [fromId])
      await q.all(
        `INSERT INTO findings (person_id, captured_at, json)
         SELECT ?, captured_at, json FROM findings WHERE person_id = ? AND 1=1
         ON CONFLICT (person_id) DO NOTHING`, [toId, fromId])
      await q.all('DELETE FROM findings WHERE person_id = ?', [fromId])
      const devices = await q.all('UPDATE devices SET person_id = ? WHERE person_id = ? RETURNING id', [toId, fromId])
      await q.all('UPDATE sso_sessions SET person_id = ? WHERE person_id = ?', [toId, fromId])
      await q.all('DELETE FROM enrollments WHERE person_id = ? AND used_at IS NULL', [fromId])
      await q.all('UPDATE people SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso(), fromId])
      return { spans: moved.length, devices: devices.length, days: days.length }
    })
  }

  /**
   * Permanently deletes a person and every row they own. Without `force` it refuses while the person still has
   * usage (merge them first). Deleting also frees their email, so they could register again.
   */
  async deletePerson(id: string, force = false): Promise<{ deleted: true; spans: number } | { deleted: false; reason: 'unknown' | 'has_usage'; spans: number }> {
    const found = await this.all('SELECT id FROM people WHERE id = ?', [id])
    if (found.length === 0) return { deleted: false, reason: 'unknown', spans: 0 }
    return this.db.tx(async q => {
      const [c] = await q.all('SELECT COUNT(*) AS n FROM spans WHERE person_id = ?', [id])
      const spans = Number(c?.n ?? 0)
      if (spans > 0 && !force) return { deleted: false as const, reason: 'has_usage' as const, spans }
      for (const t of ['spans', 'daily_usage', 'daily_names', 'sessions', 'findings', 'work_sessions', 'work_commits', 'devices', 'enrollments', 'sso_sessions']) {
        await q.all(`DELETE FROM ${t} WHERE person_id = ?`, [id])
      }
      await q.all('DELETE FROM people WHERE id = ?', [id])
      return { deleted: true as const, spans }
    })
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
      [sha256hex(token), rows[0]!.id, new Date(Date.now() + SESSION_TTL_MS).toISOString()])
    return { token, name: rows[0]!.name as string }
  }

  /** Starts a GitLab sign-in session; `subject` is the GitLab user id, kept for auditing. */
  async loginSso(s: Viewer & { subject: string }): Promise<string> {
    const token = newSecret('cbs_')
    await this.all('INSERT INTO sso_sessions (token_hash, name, role, person_id, subject, email, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sha256hex(token), s.name, s.role, s.role === 'member' ? s.personId : null, s.subject, s.role === 'registrant' ? s.email : null,
        new Date(Date.now() + SESSION_TTL_MS).toISOString()])
    return token
  }

  async viewerForSession(token: string): Promise<Viewer | null> {
    const hash = sha256hex(token)
    const now = nowIso()
    const rows = await this.all(
      `SELECT v.name AS name FROM viewer_sessions s JOIN viewers v ON v.id = s.viewer_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND v.revoked_at IS NULL`, [hash, now])
    if (rows.length > 0) return { name: rows[0]!.name as string, role: 'admin' }
    // Member sessions end as soon as their person is revoked.
    const sso = await this.all(
      `SELECT s.name AS name, s.role AS role, s.person_id AS person_id, s.email AS email FROM sso_sessions s
       LEFT JOIN people p ON p.id = s.person_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND (s.role <> 'member' OR (p.id IS NOT NULL AND p.revoked_at IS NULL))`, [hash, now])
    const r = sso[0]
    if (!r) return null
    if (r.role === 'admin') return { name: r.name, role: 'admin' }
    if (r.role === 'member') return { name: r.name, role: 'member', personId: r.person_id }
    if (r.role === 'registrant') return { name: r.name, role: 'registrant', email: r.email }
    return null
  }

  async logoutViewer(token: string): Promise<void> {
    await this.all('DELETE FROM viewer_sessions WHERE token_hash = ?', [sha256hex(token)])
    await this.all('DELETE FROM sso_sessions WHERE token_hash = ?', [sha256hex(token)])
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
          `INSERT INTO spans (span_id, person_id, device_id, ${SPAN_COLUMNS.join(', ')})
           VALUES (${['?', '?', '?', ...SPAN_COLUMNS.map(() => '?')].join(', ')})
           ON CONFLICT (span_id) DO UPDATE SET device_id = excluded.device_id, ${SPAN_COLUMNS.map(c => `${c} = excluded.${c}`).join(', ')}
           WHERE spans.person_id = excluded.person_id`,
          [s.span_id, personId, deviceId, ...spanValues(s, day)])
        stored++
      }
      for (const day of days) {
        await q.all('DELETE FROM daily_usage WHERE person_id = ? AND day = ?', [personId, day])
        await q.all(dailyUsageInsert('WHERE person_id = ? AND day = ?'), [personId, day])
        await this.rebuildDailyNames(q, personId, day)
      }
      if (withSessions) {
        for (const trace of traces) {
          await q.all('DELETE FROM sessions WHERE person_id = ? AND trace_id = ?', [personId, trace])
          await q.all(
            `INSERT INTO sessions (trace_id, person_id, project, started, duration_ms, calls, cost)
             SELECT trace_id, person_id, MAX(project), MIN(ts), COALESCE(MAX(session_duration_ms), 0), SUM(request_weight), SUM(cost_usd)
             FROM spans WHERE person_id = ? AND trace_id = ? AND detail_level = 'sessions' GROUP BY trace_id, person_id`, [personId, trace])
        }
      }
      return { stored, conflicts }
    })
  }

  /** Recomputes the MCP tool, skill and subagent name rollup for one person and day from their spans. */
  private async rebuildDailyNames(q: Querier, personId: string, day: string): Promise<void> {
    await q.all('DELETE FROM daily_names WHERE person_id = ? AND day = ?', [personId, day])
    const rows = await q.all(
      `SELECT project, cost_usd, request_weight, mcp_tools, skills, subagent_types FROM spans
       WHERE person_id = ? AND day = ? AND (mcp_tools <> '' OR skills <> '' OR subagent_types <> '')`, [personId, day])
    const agg = new Map<string, { project: string; kind: string; name: string; calls: number; cost: number }>()
    for (const r of rows) {
      for (const [col, kind] of NAME_KINDS) {
        for (const name of new Set(parseNames(r[col]))) {
          const key = `${r.project}\u0000${kind}\u0000${name}`
          const cur = agg.get(key) ?? { project: String(r.project), kind, name, calls: 0, cost: 0 }
          cur.calls += Number(r.request_weight)
          cur.cost += Number(r.cost_usd)
          agg.set(key, cur)
        }
      }
    }
    for (const a of agg.values()) {
      await q.all('INSERT INTO daily_names (person_id, day, project, kind, name, calls, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [personId, day, a.project, a.kind, a.name, a.calls, a.cost])
    }
  }

  /** Upserts git attribution for a person. A commit's in_main / was_reverted state moves forward on each resend. */
  async ingestAttribution(personId: string, sessions: WorkSessionRecord[], commits: WorkCommitRecord[]): Promise<void> {
    if (sessions.length === 0 && commits.length === 0) return
    await this.db.tx(async q => {
      for (const s of sessions) {
        await q.all(
          `INSERT INTO work_sessions (person_id, trace_id, repo, project, started, ended, commit_count, pr_links) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (person_id, trace_id) DO UPDATE SET repo = excluded.repo, project = excluded.project, started = excluded.started,
             ended = excluded.ended, commit_count = excluded.commit_count, pr_links = excluded.pr_links`,
          [personId, s.trace_id, s.repo, s.project, s.started, s.ended, s.commit_count, JSON.stringify(s.pr_links)])
      }
      for (const c of commits) {
        await q.all(
          `INSERT INTO work_commits (person_id, trace_id, repo, sha, ts, in_main, was_reverted) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (person_id, trace_id, sha) DO UPDATE SET repo = excluded.repo, ts = excluded.ts, in_main = excluded.in_main,
             was_reverted = excluded.was_reverted`,
          [personId, c.trace_id, c.repo, c.sha, c.ts, bit(c.in_main), bit(c.was_reverted)])
      }
    })
  }

  /** Records the date a device's local data is complete through. Never moves backwards. */
  async setCoverage(deviceId: string, through: string): Promise<void> {
    await this.all('UPDATE devices SET coverage_through = ? WHERE id = ? AND (coverage_through IS NULL OR coverage_through < ?)', [through, deviceId, through])
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
      await q.all('DELETE FROM daily_names WHERE day < ?', [cutoffDay])
      await q.all('DELETE FROM sessions WHERE started < ?', [cutoff])
      await q.all('DELETE FROM work_sessions WHERE ended < ?', [cutoff])
      await q.all('DELETE FROM work_commits WHERE ts < ?', [cutoff])
      await q.all('DELETE FROM viewer_sessions WHERE expires_at < ?', [now.toISOString()])
      await q.all('DELETE FROM sso_sessions WHERE expires_at < ?', [now.toISOString()])
      await q.all('DELETE FROM enrollments WHERE expires_at < ? AND used_at IS NULL', [cutoff])
      return { spans: del.length }
    })
  }
}
