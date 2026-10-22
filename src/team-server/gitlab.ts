import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { GitlabConfig } from './config.js'
import type { Store } from './store.js'

const TIMEOUT_MS = 10_000

export interface GitlabUser {
  sub: string
  name: string
  email: string
  email_verified: boolean
  groups: string[]
}

export type Access =
  | { role: 'admin'; name: string }
  | { role: 'member'; name: string; personId: string }
  | { role: 'registrant'; name: string; email: string }

export function redirectUri(publicUrl: string): string {
  return `${publicUrl}/auth/gitlab/callback`
}

/** Builds the authorize URL; `cookie` (state.verifier) must come back with the callback. */
export function startLogin(cfg: GitlabConfig, publicUrl: string): { location: string; cookie: string } {
  const state = randomBytes(24).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const q = new URLSearchParams({
    client_id: cfg.client_id,
    redirect_uri: redirectUri(publicUrl),
    response_type: 'code',
    scope: 'openid profile email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return { location: `${cfg.url}/oauth/authorize?${q}`, cookie: `${state}.${verifier}` }
}

/** Returns the PKCE verifier when the callback's state matches the cookie, else null. */
export function checkState(cookie: string | null, state: string | null): string | null {
  if (!cookie || !state) return null
  const dot = cookie.indexOf('.')
  if (dot <= 0) return null
  const expected = Buffer.from(cookie.slice(0, dot))
  const got = Buffer.from(state)
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null
  return cookie.slice(dot + 1) || null
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`GitLab ${new URL(url).pathname} returned ${res.status}`)
  return await res.json() as Record<string, unknown>
}

/** Exchanges the authorization code and reads the OIDC userinfo. */
export async function completeLogin(cfg: GitlabConfig, publicUrl: string, code: string, verifier: string): Promise<GitlabUser> {
  const token = await fetchJson(`${cfg.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(publicUrl),
      code_verifier: verifier,
    }).toString(),
  })
  if (typeof token.access_token !== 'string') throw new Error('GitLab token response has no access_token')
  const info = await fetchJson(`${cfg.url}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
  })
  if (typeof info.sub !== 'string' && typeof info.sub !== 'number') throw new Error('GitLab userinfo has no sub')
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return {
    sub: String(info.sub),
    name: str(info.name) || str(info.nickname) || str(info.preferred_username) || str(info.email),
    email: str(info.email),
    email_verified: info.email_verified === true,
    groups: Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === 'string') : [],
  }
}

/** True when any of the user's groups is one of `paths` or a subgroup of one. Group paths compare case-insensitively. */
export function inGroups(groups: string[], paths: string[]): boolean {
  const mine = groups.map(g => g.toLowerCase())
  return paths.some(p => {
    const path = p.toLowerCase()
    return mine.some(g => g === path || g.startsWith(path + '/'))
  })
}

export function registrationEnabled(cfg: GitlabConfig | undefined): boolean {
  return !!cfg && cfg.register_groups.length > 0
}

/** Decides what a signed-in GitLab user may do; null means denied. */
export async function decideAccess(store: Store, cfg: GitlabConfig, info: GitlabUser): Promise<Access | null> {
  if (inGroups(info.groups, cfg.admin_groups)) return { role: 'admin', name: info.name }
  if (!info.email_verified || !info.email) return null
  const people = await store.peopleByEmail(info.email)
  const active = people.filter(p => !p.revoked_at)
  if (active.length === 1) return { role: 'member', name: info.name, personId: active[0]!.id }
  if (people.length > 0) return null
  const anyone = cfg.register_groups.includes('*')
  if (registrationEnabled(cfg) && (anyone || inGroups(info.groups, cfg.register_groups))) {
    return { role: 'registrant', name: info.name, email: info.email }
  }
  return null
}
