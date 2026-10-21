import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TeamServerConfig } from './config.js'
import type { Store } from './store.js'
import { FailureLimiter, SESSION_COOKIE, clearedSessionCookie, isSameOriginRequest, readCookie, sessionCookie } from './auth.js'
import { computeInsights } from './insights.js'
import * as rollup from './rollup.js'

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large'> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) { req.resume(); return 'too_large' }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export interface ApiContext {
  store: Store
  config: TeamServerConfig
  tls: boolean
  limiter: FailureLimiter
}

function parseFilters(url: URL, now = new Date()): rollup.Filters | { error: string } {
  const to = url.searchParams.get('to') ?? rollup.dayOf(now)
  const from = url.searchParams.get('from') ?? rollup.addDays(to, -29)
  if (!rollup.isDay(from) || !rollup.isDay(to)) return { error: 'from and to must be YYYY-MM-DD' }
  if (from > to) return { error: 'from must not be after to' }
  if (rollup.daysBetween(from, to).length > 3660) return { error: 'range too large' }
  const f: rollup.Filters = { from, to }
  const person = url.searchParams.get('person')
  const team = url.searchParams.get('team')
  const project = url.searchParams.get('project')
  if (person) f.person = person
  if (team) f.team = team
  if (project) f.project = project
  return f
}

/** Handles every /api/team/* request. */
export async function handleApi(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!isSameOriginRequest(req)) return sendJson(res, 403, { error: 'cross_origin_forbidden' })
  const path = url.pathname.replace(/\/+$/, '')
  const { store, config } = ctx
  // Behind a TLS-terminating proxy the cookie is still Secure when the proxy says the client used https.
  const secure = ctx.tls || req.headers['x-forwarded-proto'] === 'https'

  if (path === '/api/team/login') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    const ip = req.socket.remoteAddress ?? 'unknown'
    if (ctx.limiter.blocked(ip)) return sendJson(res, 429, { error: 'too_many_attempts' })
    const raw = await readBody(req, 4096)
    let key: unknown
    try { key = raw === 'too_large' ? null : (JSON.parse(raw.toString('utf-8')) as { key?: unknown }).key } catch { key = null }
    const login = typeof key === 'string' ? await store.loginViewer(key) : null
    if (!login) {
      ctx.limiter.fail(ip)
      return sendJson(res, 401, { error: 'invalid_key' })
    }
    return sendJson(res, 200, { viewer: { name: login.name } }, { 'set-cookie': sessionCookie(login.token, secure) })
  }

  const token = readCookie(req, SESSION_COOKIE)
  const viewer = token ? await store.viewerForSession(token) : null
  if (!viewer) return sendJson(res, 401, { error: 'unauthenticated' })

  if (path === '/api/team/logout') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    await store.logoutViewer(token!)
    return sendJson(res, 200, { ok: true }, { 'set-cookie': clearedSessionCookie(secure) })
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })

  const filters = parseFilters(url)
  if ('error' in filters) return sendJson(res, 400, { error: filters.error })

  if (path === '/api/team/meta') {
    const roster = await store.all('SELECT id, name, team FROM people WHERE revoked_at IS NULL ORDER BY name, id')
    return sendJson(res, 200, {
      org_name: config.org_name,
      detail_levels: config.accept_session_detail ? ['summary', 'sessions'] : ['summary'],
      accept_findings: config.accept_findings,
      viewer: { name: viewer.name },
      teams: [...new Set(roster.map(p => String(p.team)).filter(Boolean))].sort(),
      people: roster.map(p => ({ id: p.id, name: p.name, team: p.team })),
    })
  }
  if (path === '/api/team/overview') {
    return sendJson(res, 200, await rollup.overview(store, filters, url.searchParams.get('compare') === 'previous'))
  }
  if (path === '/api/team/people') {
    return sendJson(res, 200, { people: await rollup.people(store, filters) })
  }
  const personMatch = /^\/api\/team\/people\/([^/]+)$/.exec(path)
  if (personMatch) {
    const detail = await rollup.personDetail(store, decodeURIComponent(personMatch[1]!), filters)
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'not_found' })
  }
  if (path === '/api/team/models') return sendJson(res, 200, await rollup.models(store, filters))
  if (path === '/api/team/projects') return sendJson(res, 200, { projects: await rollup.projects(store, filters) })
  if (path === '/api/team/sessions') {
    if (!config.accept_session_detail) return sendJson(res, 404, { error: 'sessions_disabled' })
    return sendJson(res, 200, { sessions: await rollup.sessions(store, filters) })
  }
  if (path === '/api/team/insights') {
    return sendJson(res, 200, await computeInsights(store, filters, { includeFindings: config.accept_findings }))
  }
  return sendJson(res, 404, { error: 'not_found' })
}
