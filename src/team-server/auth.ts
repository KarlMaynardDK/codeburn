import type { IncomingMessage } from 'node:http'

export const SESSION_COOKIE = 'cb_team_session'
export const SESSION_MAX_AGE_S = 43200

export function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  if (typeof h !== 'string') return null
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  return m ? m[1]! : null
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}${secure ? '; Secure' : ''}`
}

export const OAUTH_COOKIE = 'cb_team_oauth'
export const OAUTH_COOKIE_PATH = '/auth/gitlab'

/** Holds the OAuth state and PKCE verifier between login and callback. Lax: the callback is a cross-site navigation. */
export function oauthCookie(value: string, secure: boolean): string {
  return `${OAUTH_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=${OAUTH_COOKIE_PATH}; Max-Age=600${secure ? '; Secure' : ''}`
}

export function clearedOauthCookie(secure: boolean): string {
  return `${OAUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=${OAUTH_COOKIE_PATH}; Max-Age=0${secure ? '; Secure' : ''}`
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`
}

/**
 * Same-origin guard for the viewer API (modelled on src/web-dashboard.ts, but against the
 * request's own Host rather than loopback). Returns true when the request may proceed.
 *  - an Origin header must name the same host as the Host header;
 *  - Sec-Fetch-Site, when sent, must be same-origin or none;
 *  - state-changing methods need a matching Origin or Sec-Fetch-Site: same-origin.
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  let originOk = false
  if (typeof origin === 'string') {
    try {
      if (!host || new URL(origin).host !== host) return false
      originOk = true
    } catch {
      return false
    }
  }
  const safe = req.method === 'GET' || req.method === 'HEAD'
  if (safe) return true
  return originOk || site === 'same-origin'
}

/** Sliding-window failure counter keyed by caller, to slow down viewer-key guessing. */
export class FailureLimiter {
  private hits = new Map<string, number[]>()
  constructor(private max = 10, private windowMs = 60_000) {}
  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    this.hits.set(key, recent)
    return recent.length >= this.max
  }
  fail(key: string, now = Date.now()): void {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    recent.push(now)
    this.hits.set(key, recent)
  }
}

/** CLI version a device reports in X-Codeburn-Client-Version; null when absent or not a plain version string. */
export function clientVersion(req: IncomingMessage): string | null {
  const v = req.headers['x-codeburn-client-version']
  const value = Array.isArray(v) ? v[0] : v
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(value) ? value : null
}
