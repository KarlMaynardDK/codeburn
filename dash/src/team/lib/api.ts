// Client for the team server's viewer API (see docs: Viewer API contract).

export class ApiError extends Error {
  status: number
  code: string | undefined
  constructor(status: number, code?: string) {
    super(code ?? `Request failed (${status})`)
    this.status = status
    this.code = code
  }
}

let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

export type Query = Record<string, string | undefined | null>

function qs(q?: Query): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q ?? {})) if (v) p.set(k, v)
  const s = p.toString()
  return s ? '?' + s : ''
}

async function request<T>(method: 'GET' | 'POST', path: string, q?: Query, body?: unknown, quiet401 = false): Promise<T> {
  const res = await fetch(path + qs(q), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let code: string | undefined
    try {
      code = ((await res.json()) as { error?: string }).error
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && !quiet401) onUnauthorized()
    throw new ApiError(res.status, code)
  }
  return (await res.json()) as T
}

export const login = (key: string) =>
  request<{ viewer: { name: string } }>('POST', '/api/team/login', undefined, { key }, true)
export const logout = () => request<unknown>('POST', '/api/team/logout', undefined, {}, true).catch(() => undefined)

export type AuthMethods = { key: boolean; gitlab: boolean; registration: boolean }
export const getAuthMethods = () =>
  request<AuthMethods>('GET', '/api/team/auth-methods', undefined, undefined, true).catch(
    (): AuthMethods => ({ key: true, gitlab: false, registration: false }),
  )

// ---- Self-registration -----------------------------------------------------
export type Registration =
  | { state: 'new'; name: string; email: string; teams: string[]; note: string }
  | { state: 'member'; name: string; email: string; team: string; note: string }
export type InstallInfo = {
  token: string
  expires_at: string
  url: string
  install: { unix: string; windows: string } | null
  setup: string
  person: { name: string; email: string; team: string }
}
export const getRegistration = () => request<Registration>('GET', '/api/team/registration')
export const register = (team: string) => request<InstallInfo>('POST', '/api/team/registration', undefined, { team })
export const newInstallToken = () => request<InstallInfo>('POST', '/api/team/registration/token', undefined, {})

// ---- Member profile --------------------------------------------------------
export type Profile = {
  name: string
  email: string
  team: string
  /** Teams already in use, for the picker. */
  teams: string[]
  /** Every project the member has sent usage for, under its real name. Only the member ever sees these. */
  projects: Array<{ project: string; hidden: boolean; cost: number }>
}
export type ProfileChange = { name?: string; team?: string; hidden_projects?: string[] }
export const getProfile = () => request<Profile>('GET', '/api/team/profile')
export const saveProfile = (change: ProfileChange) => request<Profile>('POST', '/api/team/profile', undefined, change)

// ---- Types -----------------------------------------------------------------
export type Role = 'admin' | 'member' | 'registrant'
export type Breakdown = { name: string; cost: number; tokens: number; calls?: number }
export type Meta = {
  org_name?: string
  detail_levels?: string[]
  accept_findings?: boolean
  viewer?: { name: string; role?: Role }
  /** Set for members: the only person they can see. */
  person_id?: string
  registration?: boolean
  teams?: string[]
  people?: Array<{ id: string; name: string; team?: string | null }>
}
export type DailyRow = { day: string; cost: number; input: number; output: number; cache_read: number; cache_write: number; calls: number }
/** Counts newer clients send per call. Zero when every client in the period predates them. */
export type Extras = {
  reasoning: number
  cache_write_1h: number
  web_search: number
  estimated_cost_usd: number
  covered_cost_usd: number
  savings_usd: number
  nano_aiu: number
  lines_added: number
  lines_removed: number
  tool_errors: number
  interrupted: number
  user_modified: number
  active_ms: number
  tool_wait_ms: number
  turns: number
  edit_turns: number
  one_shot_turns: number
  retries: number
  plan_mode_calls: number
  /** Null when no turn outcomes were sent for the period. */
  one_shot_rate: number | null
}
export const EMPTY_EXTRAS: Extras = {
  reasoning: 0, cache_write_1h: 0, web_search: 0, estimated_cost_usd: 0, covered_cost_usd: 0, savings_usd: 0, nano_aiu: 0,
  lines_added: 0, lines_removed: 0, tool_errors: 0, interrupted: 0, user_modified: 0, active_ms: 0, tool_wait_ms: 0,
  turns: 0, edit_turns: 0, one_shot_turns: 0, retries: 0, plan_mode_calls: 0, one_shot_rate: null,
}
export type Overview = {
  totals: { cost: number; input: number; output: number; cache_read: number; cache_write: number; calls: number; active_people: number } & Extras
  daily: DailyRow[]
  mtd?: { cost: number; projected_month_cost: number; days_elapsed: number; days_in_month: number }
  by_provider: Breakdown[]
  by_model: Breakdown[]
  by_team: Breakdown[]
  by_speed: Breakdown[]
  by_route: Breakdown[]
  by_billing: Breakdown[]
  compare?: { cost: number; tokens: number }
}
export type PersonRow = Extras & {
  id: string
  name: string
  email?: string | null
  team?: string | null
  cost: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  calls: number
  cache_read_ratio: number
  top_model?: string | null
  trend: number[]
  last_seen?: string | null
  /** Latest date any of the person's devices reported its data complete through. */
  data_through?: string | null
}
export type NameRow = { kind: 'mcp' | 'skill' | 'subagent' | string; name: string; calls: number; cost: number; people: number }
export type ToolsData = { names: NameRow[]; plan_mode: { calls: number; people: number; share: number } }
export type RepoRow = { repo: string; sessions: number; cost: number; people: number; prs: number; commits: number; landed: number; reverted: number }
export type PrRow = { url: string; repo: string; sessions: number; cost: number; people: number }
export type WorkData = { repos: RepoRow[]; prs: PrRow[] }
export type PersonDetail = {
  person: PersonRow
  by_provider: Breakdown[]
  by_model: Breakdown[]
  by_project: Breakdown[]
  by_category: Breakdown[]
  daily: DailyRow[]
}
export type MatrixCell = { model: string; category: string; cost: number; tokens: number; calls: number; people: number }
export type ModelsData = { matrix: MatrixCell[]; by_model: Breakdown[] }
export type ProjectRow = { project: string; cost: number; tokens: number; calls: number; people: number; top_person?: string | null }
export type SessionRow = { trace_id: string; person: string; project: string; started: string; duration_ms: number; calls: number; cost: number }
export type Insight = { id: string; severity: 'info' | 'warn'; title: string; detail: string; person?: string; value?: number }
export type Finding = { title: string; people: number; estimated_savings_usd: number }

// ---- Endpoints (each normalises missing arrays so the UI never crashes) ----
export type Filters = { from: string; to: string; team?: string; person?: string; project?: string }
const f = (x: Filters): Query => ({ from: x.from, to: x.to, team: x.team, person: x.person, project: x.project })

export const getMeta = () => request<Meta>('GET', '/api/team/meta')

export async function getOverview(x: Filters, compare: boolean): Promise<Overview> {
  const o = await request<Partial<Overview>>('GET', '/api/team/overview', { ...f(x), compare: compare ? 'previous' : undefined })
  return {
    totals: { cost: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, calls: 0, active_people: 0, ...EMPTY_EXTRAS, ...o.totals },
    daily: o.daily ?? [],
    mtd: o.mtd,
    by_provider: o.by_provider ?? [],
    by_model: o.by_model ?? [],
    by_team: o.by_team ?? [],
    by_speed: o.by_speed ?? [],
    by_route: o.by_route ?? [],
    by_billing: o.by_billing ?? [],
    compare: o.compare,
  }
}

export async function getPeople(x: Filters): Promise<PersonRow[]> {
  const r = await request<{ people?: PersonRow[] }>('GET', '/api/team/people', f(x))
  return (r.people ?? []).map((p) => ({ ...EMPTY_EXTRAS, ...p, trend: p.trend ?? [] }))
}

export async function getPerson(id: string, x: Filters): Promise<PersonDetail> {
  const r = await request<Partial<PersonDetail>>('GET', `/api/team/people/${encodeURIComponent(id)}`, f(x))
  return {
    person: { ...EMPTY_EXTRAS, ...(r.person as PersonRow), trend: r.person?.trend ?? [] },
    by_provider: r.by_provider ?? [],
    by_model: r.by_model ?? [],
    by_project: r.by_project ?? [],
    by_category: r.by_category ?? [],
    daily: r.daily ?? [],
  }
}

export async function getModels(x: Filters): Promise<ModelsData> {
  const r = await request<Partial<ModelsData>>('GET', '/api/team/models', f(x))
  return { matrix: r.matrix ?? [], by_model: r.by_model ?? [] }
}

export async function getProjects(x: Filters): Promise<ProjectRow[]> {
  return (await request<{ projects?: ProjectRow[] }>('GET', '/api/team/projects', f(x))).projects ?? []
}

export async function getSessions(x: Filters): Promise<SessionRow[]> {
  return (await request<{ sessions?: SessionRow[] }>('GET', '/api/team/sessions', f(x))).sessions ?? []
}

export async function getTools(x: Filters): Promise<ToolsData> {
  const r = await request<Partial<ToolsData>>('GET', '/api/team/tools', f(x))
  return { names: r.names ?? [], plan_mode: r.plan_mode ?? { calls: 0, people: 0, share: 0 } }
}

export async function getWork(x: Filters): Promise<WorkData> {
  const r = await request<Partial<WorkData>>('GET', '/api/team/work', f(x))
  return { repos: r.repos ?? [], prs: r.prs ?? [] }
}

export async function getInsights(x: Filters): Promise<{ insights: Insight[]; findings: Finding[] }> {
  const r = await request<{ insights?: Insight[]; findings?: Finding[] }>('GET', '/api/team/insights', f(x))
  return { insights: r.insights ?? [], findings: r.findings ?? [] }
}
