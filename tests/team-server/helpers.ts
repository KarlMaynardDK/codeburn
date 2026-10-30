import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { DEFAULT_CONFIG, type TeamServerConfig } from '../../src/team-server/config.js'
import { migrate, Store, type Db } from '../../src/team-server/store.js'
import type { ClientPackage } from '../../src/team-server/client-package.js'
import { createTeamServer } from '../../src/team-server/server.js'

export const PG_URL = process.env.CODEBURN_TEST_PG_URL
export const BACKENDS: Array<'sqlite' | 'postgres'> = ['sqlite', ...(PG_URL ? ['postgres' as const] : [])]

export interface TestStore { store: Store; cleanup: () => Promise<void> }

export async function makeStore(backend: 'sqlite' | 'postgres'): Promise<TestStore> {
  if (backend === 'postgres') {
    const { openPostgres } = await import('../../src/team-server/store-postgres.js')
    const db = await openPostgres(PG_URL!, { schema: `t_${randomBytes(6).toString('hex')}` })
    await migrate(db)
    return { store: new Store(db), cleanup: async () => { await db.dropSchema(); await db.close() } }
  }
  const dir = await mkdtemp(join(tmpdir(), 'codeburn-team-'))
  const { openSqlite } = await import('../../src/team-server/store-sqlite.js')
  const db: Db = openSqlite(dir)
  await migrate(db)
  return { store: new Store(db), cleanup: async () => { await db.close(); await rm(dir, { recursive: true, force: true }) } }
}

export interface TestServer extends TestStore {
  base: string
  host: string
  config: TeamServerConfig
  server: Server
}

export async function startServer(backend: 'sqlite' | 'postgres', overrides: Partial<TeamServerConfig> = {}, staticDir?: string, clientPackage?: ClientPackage): Promise<TestServer> {
  const ts = await makeStore(backend)
  const config = { ...DEFAULT_CONFIG, ...overrides }
  const server = createTeamServer({ store: ts.store, config, ...(clientPackage ? { clientPackage } : {}), staticDir: staticDir ?? join(tmpdir(), 'codeburn-no-such-dir') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    ...ts, config, server, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`,
    cleanup: async () => { await new Promise<void>(r => { server.close(() => r()); server.closeAllConnections() }); await ts.cleanup() },
  }
}

// ---- OTLP builders (mirror src/sync/otlp.ts shapes) ----

export type Attr = { key: string; value: Record<string, unknown> }
export const s = (key: string, v: string): Attr => ({ key, value: { stringValue: v } })
export const i = (key: string, v: number): Attr => ({ key, value: { intValue: String(v) } })
export const d = (key: string, v: number): Attr => ({ key, value: { doubleValue: v } })
export const b = (key: string, v: boolean): Attr => ({ key, value: { boolValue: v } })
export const arr = (key: string, v: string[]): Attr => ({ key, value: { arrayValue: { values: v.map(x => ({ stringValue: x })) } } })

export interface SpanSpec {
  id: string
  trace?: string
  /** ms epoch; defaults to the start of the current hour. */
  at?: number
  provider?: string
  model?: string
  project?: string
  category?: string | null
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
  session?: boolean
  speed?: string
  /** Extra attributes appended as-is. */
  attrs?: Attr[]
}

export const hoursAgo = (h: number) => Math.floor((Date.now() - h * 3600_000) / 3600_000) * 3600_000
export const daysAgo = (n: number) => hoursAgo(n * 24 + 1)
export const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function span(o: SpanSpec) {
  const at = o.at ?? hoursAgo(1)
  const attrs: Attr[] = [
    s('ai.provider', o.provider ?? 'claude'),
    s('ai.model', o.model ?? 'claude-sonnet-4'),
    i('ai.input_tokens', o.input ?? 100),
    i('ai.output_tokens', o.output ?? 50),
    d('ai.cost_usd', o.cost ?? 0.5),
    s('ai.speed', o.speed ?? 'standard'),
    s('ai.project', o.project ?? 'app'),
    i('ai.cache_read_tokens', o.cacheRead ?? 0),
    i('ai.cache_write_tokens', o.cacheWrite ?? 0),
  ]
  if (o.category !== null) attrs.push(s('ai.category', o.category ?? 'coding'))
  if (o.session) {
    attrs.push(s('ai.work_unit_id', 'wu1'), s('ai.session_role', 'root'), s('ai.lineage_evidence', 'provider'),
      i('ai.session_duration_ms', 90_000), i('ai.call_count', 3))
  }
  attrs.push(...(o.attrs ?? []))
  return {
    traceId: o.trace ?? 'a'.repeat(32),
    spanId: o.id,
    name: 'ai.usage',
    startTimeUnixNano: (BigInt(at) * 1_000_000n).toString(),
    endTimeUnixNano: (BigInt(at + 1) * 1_000_000n).toString(),
    attributes: attrs,
  }
}

export function payload(spans: unknown[], level: 'summary' | 'sessions' | null = 'sessions', resource: Attr[] = []) {
  const attributes: Attr[] = [s('codeburn.device_id', 'someone-else'), ...resource]
  if (level) attributes.push(s('codeburn.detail_level', level))
  return { resourceSpans: [{ resource: { attributes }, scopeSpans: [{ spans }] }] }
}

export async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers }
}

/** Enrolls a fresh person through the HTTP API, returning a device credential. */
export async function enrollPerson(t: TestServer, name: string, team = 'core', email = `${name.toLowerCase()}@example.com`) {
  const { person, enrollmentToken } = await t.store.addPerson({ name, email, team })
  const r = await post(t.base, '/v1/enroll', { token: enrollmentToken, label: `${name}-laptop` })
  return { person, cred: r.json.credential as string, deviceId: r.json.device_id as string }
}

export const send = (t: TestServer, cred: string, spans: unknown[], level: 'summary' | 'sessions' | null = 'sessions') =>
  post(t.base, '/v1/traces', payload(spans, level), { authorization: `Bearer ${cred}` })

/** Logs in with a fresh viewer key and returns a same-origin fetch helper carrying the cookie. */
export async function viewerClient(t: TestServer) {
  const { key } = await t.store.addViewer('Boss')
  const login = await post(t.base, '/api/team/login', { key }, { origin: `http://${t.host}` })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
  const get = async (path: string) => {
    const res = await fetch(t.base + path, { headers: { cookie } })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  return { key, login, cookie, get }
}
