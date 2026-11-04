import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TeamServerConfig } from './config.js'
import { cleanProjectNames, type Person, type Store, type Viewer } from './store.js'
import { FailureLimiter, SESSION_COOKIE, clearedSessionCookie, isSameOriginRequest, readCookie, sessionCookie } from './auth.js'
import { installerLines, setupCommand } from './client-package.js'
import { registrationEnabled } from './gitlab.js'
import { postSetupSteps } from './help.js'
import { coachingOverview, computeInsights } from './insights.js'
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
  /** Caps install tokens minted per session from the registration page. */
  tokenLimiter: FailureLimiter
  /** True when /install.sh and /install.ps1 are served. */
  installers: boolean
}

/** What the registration page shows once a token exists. */
function installResponse(ctx: ApiContext, person: Pick<Person, 'name' | 'email' | 'team'>, token: string, expiresAt: string) {
  const url = ctx.config.public_url ?? ''
  return {
    token,
    expires_at: expiresAt,
    url,
    install: ctx.installers ? installerLines(url, token) : null,
    setup: setupCommand(url, token),
    steps: postSetupSteps(ctx.config),
    person: { name: person.name, email: person.email, team: person.team },
  }
}

async function readTeam(req: IncomingMessage): Promise<string | null> {
  const raw = await readBody(req, 4096)
  if (raw === 'too_large') return null
  try {
    const team = (JSON.parse(raw.toString('utf-8')) as { team?: unknown }).team
    return typeof team === 'string' ? team : null
  } catch {
    return null
  }
}

async function handleRegistration(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, path: string, viewer: Viewer, token: string): Promise<void> {
  const { store, config } = ctx
  if (!registrationEnabled(config.gitlab) || viewer.role === 'admin') return sendJson(res, 404, { error: 'not_found' })
  const note = config.gitlab?.register_note ?? ''

  if (path === '/api/team/registration') {
    if (req.method === 'GET') {
      if (viewer.role === 'registrant') {
        return sendJson(res, 200, { state: 'new', name: viewer.name, email: viewer.email, teams: await store.distinctTeams(), note })
      }
      const person = await store.getPerson(viewer.personId)
      if (!person) return sendJson(res, 404, { error: 'not_found' })
      return sendJson(res, 200, { state: 'member', name: person.name, email: person.email, team: person.team, note })
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (viewer.role !== 'registrant') return sendJson(res, 409, { error: 'already_registered' })
    if (ctx.tokenLimiter.blocked(token)) return sendJson(res, 429, { error: 'too_many_attempts' })
    ctx.tokenLimiter.fail(token)
    const r = await store.registerSelf(token, (await readTeam(req)) ?? '')
    if ('error' in r) {
      const status = r.error === 'invalid_team' ? 400 : r.error === 'email_taken' ? 409 : 403
      return sendJson(res, status, { error: r.error })
    }
    process.stderr.write(`team-server: registered ${r.person.name} <${r.person.email}> team=${r.person.team} (${r.person.id})\n`)
    return sendJson(res, 200, installResponse(ctx, r.person, r.enrollmentToken, r.expiresAt))
  }

  if (path === '/api/team/registration/token') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
    if (viewer.role !== 'member' && viewer.role !== 'team_admin') return sendJson(res, 403, { error: 'registration_required' })
    if (ctx.tokenLimiter.blocked(token)) return sendJson(res, 429, { error: 'too_many_attempts' })
    ctx.tokenLimiter.fail(token)
    const person = await store.getPerson(viewer.personId)
    const fresh = person ? await store.rotateEnrollment(person.id) : null
    if (!person || !fresh) return sendJson(res, 404, { error: 'not_found' })
    process.stderr.write(`team-server: new install token for ${person.name} <${person.email}> (${person.id})\n`)
    return sendJson(res, 200, installResponse(ctx, person, fresh, new Date(Date.now() + 7 * 86_400_000).toISOString()))
  }
  return sendJson(res, 404, { error: 'not_found' })
}

/** The spelling of `team` among a team admin's teams, compared ignoring case and spacing; null when it is not one of theirs. */
function managedTeam(viewer: Viewer, team: string): string | null {
  if (viewer.role === 'admin') return team
  if (viewer.role !== 'team_admin') return null
  const key = team.trim().toLowerCase()
  return viewer.teams.find(t => t.trim().toLowerCase() === key) ?? null
}

/**
 * Manage people. Full admins: create anyone, issue any token, grant team-admin. Team admins: create people in, and issue
 * tokens for people in, only the teams they administer. Everyone else gets 404.
 */
async function handleAdmin(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, path: string, viewer: Viewer, token: string): Promise<void> {
  if (viewer.role !== 'admin' && viewer.role !== 'team_admin') return sendJson(res, 404, { error: 'not_found' })
  const { store } = ctx
  const sub = /^\/api\/team\/admin\/people\/([^/]+)\/(token|team-admin)$/.exec(path)
  if (path !== '/api/team/admin/people' && !sub) return sendJson(res, 404, { error: 'not_found' })
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })

  if (sub?.[2] === 'team-admin') {
    if (viewer.role !== 'admin') return sendJson(res, 404, { error: 'not_found' })
    const raw = await readBody(req, 4096)
    let body: { teams?: unknown }
    try { body = raw === 'too_large' ? {} : JSON.parse(raw.toString('utf-8')) } catch { return sendJson(res, 400, { error: 'invalid_json' }) }
    const teams = body?.teams
    if (!Array.isArray(teams) || teams.length > 100 || teams.some(t => typeof t !== 'string')) return sendJson(res, 400, { error: 'invalid_team' })
    const id = decodeURIComponent(sub[1]!)
    const r = await store.setTeamAdmin(id, teams as string[])
    if ('error' in r) return sendJson(res, r.error === 'not_found' ? 404 : 400, { error: r.error })
    process.stderr.write(`team-server: team admin of ${r.join(', ') || '(none)'} set for ${id} by ${viewer.name}\n`)
    return sendJson(res, 200, { teams: r })
  }

  if (ctx.tokenLimiter.blocked(token)) return sendJson(res, 429, { error: 'too_many_attempts' })

  if (sub) {
    const person = await store.getPerson(decodeURIComponent(sub[1]!))
    if (!person || person.revoked_at || (viewer.role === 'team_admin' && !viewer.teams.includes(person.team))) return sendJson(res, 404, { error: 'not_found' })
    ctx.tokenLimiter.fail(token)
    const fresh = await store.rotateEnrollment(person.id)
    if (!fresh) return sendJson(res, 404, { error: 'not_found' })
    process.stderr.write(`team-server: ${viewer.name} issued a new install token for ${person.name} <${person.email}> (${person.id})\n`)
    return sendJson(res, 200, installResponse(ctx, person, fresh, new Date(Date.now() + 7 * 86_400_000).toISOString()))
  }

  const raw = await readBody(req, 4096)
  let body: { name?: unknown; email?: unknown; team?: unknown }
  try { body = raw === 'too_large' ? {} : JSON.parse(raw.toString('utf-8')) } catch { return sendJson(res, 400, { error: 'invalid_json' }) }
  if (raw === 'too_large' || !body || typeof body !== 'object') return sendJson(res, 400, { error: 'invalid_json' })
  if (typeof body.name !== 'string') return sendJson(res, 400, { error: 'invalid_name' })
  if (typeof body.email !== 'string') return sendJson(res, 400, { error: 'invalid_email' })
  if (typeof body.team !== 'string') return sendJson(res, 400, { error: 'invalid_team' })
  const team = managedTeam(viewer, body.team)
  if (team === null) return sendJson(res, 403, { error: 'team_not_allowed' })
  ctx.tokenLimiter.fail(token)
  const r = await store.createPerson({ name: body.name, email: body.email, team })
  if ('error' in r) return sendJson(res, r.error === 'email_taken' ? 409 : 400, { error: r.error })
  process.stderr.write(`team-server: ${viewer.name} created ${r.person.name} <${r.person.email}> team=${r.person.team} (${r.person.id})\n`)
  return sendJson(res, 200, installResponse(ctx, r.person, r.enrollmentToken, r.expiresAt))
}

async function profileResponse(store: Store, personId: string) {
  const person = await store.getPerson(personId)
  if (!person) return null
  return { name: person.name, email: person.email, team: person.team, teams: await store.distinctTeams(), projects: await store.memberProjects(personId) }
}

/**
 * A member's own details: GET reads them, POST changes the name, the team and/or the hidden projects. Identity comes
 * from the session only. Hidden project names are never visible to anyone else, admins included.
 */
async function handleProfile(ctx: ApiContext, req: IncomingMessage, res: ServerResponse, viewer: Viewer): Promise<void> {
  const { store } = ctx
  if (viewer.role === 'registrant') return sendJson(res, 403, { error: 'registration_required' })
  if (viewer.role !== 'member' && viewer.role !== 'team_admin') return sendJson(res, 404, { error: 'not_found' })

  if (req.method === 'POST') {
    const raw = await readBody(req, 128 * 1024)
    let body: { name?: unknown; team?: unknown; hidden_projects?: unknown }
    try { body = raw === 'too_large' ? {} : JSON.parse(raw.toString('utf-8')) } catch { return sendJson(res, 400, { error: 'invalid_json' }) }
    if (raw === 'too_large' || !body || typeof body !== 'object') return sendJson(res, 400, { error: 'invalid_json' })
    if (body.name !== undefined && typeof body.name !== 'string') return sendJson(res, 400, { error: 'invalid_name' })
    if (body.team !== undefined && typeof body.team !== 'string') return sendJson(res, 400, { error: 'invalid_team' })
    const hidden = body.hidden_projects
    if (hidden !== undefined && (!Array.isArray(hidden) || hidden.length > 1000 || hidden.some(h => typeof h !== 'string'))) {
      return sendJson(res, 400, { error: 'invalid_projects' })
    }
    if (hidden !== undefined && !cleanProjectNames(hidden as string[])) return sendJson(res, 400, { error: 'invalid_projects' })
    // Everything is validated before the first write, so a bad field changes nothing.
    if (body.name !== undefined || body.team !== undefined) {
      const r = await store.updateProfile(viewer.personId, { name: body.name as string | undefined, team: body.team as string | undefined })
      if ('error' in r) return sendJson(res, r.error === 'not_found' ? 404 : 400, { error: r.error })
    }
    if (hidden !== undefined) await store.setHiddenProjects(viewer.personId, hidden as string[])
    process.stderr.write(`team-server: profile updated for ${viewer.personId}
`)
  } else if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method_not_allowed' })
  }
  const profile = await profileResponse(store, viewer.personId)
  return profile ? sendJson(res, 200, profile) : sendJson(res, 404, { error: 'not_found' })
}

/** True when the person is the viewer or belongs to one of the viewer's administered teams. */
async function personInScope(store: Store, personId: string, viewer: Extract<Viewer, { role: 'team_admin' }>): Promise<boolean> {
  if (personId === viewer.personId) return true
  const p = await store.getPerson(personId)
  return !!p && viewer.teams.includes(p.team)
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

  if (path === '/api/team/auth-methods') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
    return sendJson(res, 200, { key: true, gitlab: !!config.gitlab, registration: registrationEnabled(config.gitlab) })
  }

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
  if (path === '/api/team/registration' || path.startsWith('/api/team/registration/')) {
    return handleRegistration(ctx, req, res, path, viewer, token!)
  }
  if (path === '/api/team/profile') return handleProfile(ctx, req, res, viewer)
  if (path === '/api/team/admin' || path.startsWith('/api/team/admin/')) return handleAdmin(ctx, req, res, path, viewer, token!)
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })

  const base = {
    org_name: config.org_name,
    detail_levels: config.accept_session_detail ? ['summary', 'sessions'] : ['summary'],
    accept_findings: config.accept_findings,
    accept_coaching: config.accept_coaching,
    viewer: { name: viewer.name, role: viewer.role },
    registration: registrationEnabled(config.gitlab),
  }
  if (viewer.role === 'registrant') {
    if (path === '/api/team/meta') return sendJson(res, 200, { ...base, teams: [], people: [] })
    return sendJson(res, 403, { error: 'registration_required' })
  }

  const filters = parseFilters(url)
  if ('error' in filters) return sendJson(res, 400, { error: filters.error })
  // Members see only their own data: one override scopes every rollup and insight query.
  if (viewer.role === 'member') {
    filters.person = viewer.personId
    delete filters.team
  }
  // Team admins are limited to their teams (and themselves): the scope is set here and never read from the request.
  let scopeTeams: string[] = []
  if (viewer.role === 'team_admin') {
    scopeTeams = viewer.teams
    filters.scope = { teams: viewer.teams, personId: viewer.personId }
    if (filters.team && !scopeTeams.includes(filters.team)) delete filters.team
    if (filters.person && !(await personInScope(store, filters.person, viewer))) return sendJson(res, 404, { error: 'not_found' })
  }

  if (path === '/api/team/meta') {
    if (viewer.role === 'member') {
      const me = await store.getPerson(viewer.personId)
      return sendJson(res, 200, { ...base, person_id: viewer.personId, teams: [], people: me ? [{ id: me.id, name: me.name, team: me.team }] : [] })
    }
    const roster = (await store.all('SELECT id, name, team FROM people WHERE revoked_at IS NULL ORDER BY name, id'))
      .filter(p => viewer.role !== 'team_admin' || rollup.inScope(filters, p))
    const grants = viewer.role === 'admin' ? await store.listTeamAdmins() : undefined
    return sendJson(res, 200, {
      ...base,
      ...(viewer.role === 'team_admin' ? { person_id: viewer.personId } : {}),
      teams: viewer.role === 'team_admin' ? scopeTeams : [...new Set(roster.map(p => String(p.team)).filter(Boolean))].sort(),
      people: roster.map(p => ({ id: p.id, name: p.name, team: p.team, ...(grants ? { team_admin_of: grants[p.id as string] ?? [] } : {}) })),
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
    if (viewer.role === 'member' && decodeURIComponent(personMatch[1]!) !== viewer.personId) return sendJson(res, 404, { error: 'not_found' })
    if (viewer.role === 'team_admin' && !(await personInScope(store, decodeURIComponent(personMatch[1]!), viewer))) return sendJson(res, 404, { error: 'not_found' })
    const detail = await rollup.personDetail(store, decodeURIComponent(personMatch[1]!), filters)
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'not_found' })
  }
  if (path === '/api/team/models') return sendJson(res, 200, await rollup.models(store, filters))
  if (path === '/api/team/projects') return sendJson(res, 200, { projects: await rollup.projects(store, filters) })
  if (path === '/api/team/tools') return sendJson(res, 200, await rollup.tools(store, filters))
  if (path === '/api/team/sessions') {
    if (!config.accept_session_detail) return sendJson(res, 404, { error: 'sessions_disabled' })
    return sendJson(res, 200, { sessions: await rollup.sessions(store, filters) })
  }
  if (path === '/api/team/work') {
    if (!config.accept_session_detail) return sendJson(res, 404, { error: 'sessions_disabled' })
    return sendJson(res, 200, await rollup.work(store, filters))
  }
  if (path === '/api/team/insights') {
    return sendJson(res, 200, await computeInsights(store, filters, { includeFindings: config.accept_findings, includeCoaching: config.accept_coaching }))
  }
  if (path === '/api/team/coaching') {
    return sendJson(res, 200, await coachingOverview(store, filters, { includeCoaching: config.accept_coaching }))
  }
  return sendJson(res, 404, { error: 'not_found' })
}
