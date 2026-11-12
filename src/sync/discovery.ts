/**
 * codeburn sync — discovery document parser.
 *
 * Fetches and validates {baseUrl}/.well-known/codeburn-export.json
 */

export interface CodeburnDiscoveryDoc {
  version: number
  issuer: string
  client_id: string
  scopes: string[]
  traces_path: string
  max_batch_size: number
  /** Oldest span (in days) the server accepts; older ones are rejected. Absent = no stated limit. */
  max_span_age_days?: number
  /** "enrollment" = self-hosted team server (no IdP); otherwise OIDC. */
  auth?: 'enrollment' | 'oidc'
  enroll_path?: string
  /** Where an enrolled device revokes its own credential (team servers that support it). */
  revoke_path?: string
  /** Detail levels the server accepts. Defaults to ["summary"]. */
  detail_levels: DetailLevel[]
  findings_path?: string
  /** Where a coaching snapshot (counts only) is uploaded, when the server accepts it. */
  coaching_path?: string
  org_name?: string
  /** The CLI build a team server distributes (self-hosted team servers only). */
  client_package?: ClientPackageInfo
}

export interface ClientPackageInfo { version: string; sha256: string; path: string }

export type DetailLevel = 'summary' | 'sessions'

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

/**
 * Enforce https on remote endpoints (RFC 8252 §8.3). Refresh tokens and
 * bearer tokens travel on these URLs — plaintext http is only permitted
 * for loopback addresses (local development and offline tests).
 */
export function assertHttps(url: string, label: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new DiscoveryError(`${label} is not a valid URL: ${url}`)
  }
  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return
  throw new DiscoveryError(
    `${label} must use https (got ${parsed.protocol}//${parsed.host}). ` +
    `Plain http is only allowed for loopback (127.0.0.1).`
  )
}

const SUPPORTED_VERSION = 1

const PKG_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** Validates an advertised client package; anything malformed is dropped rather than trusted. */
export function parseClientPackage(raw: unknown): ClientPackageInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const p = raw as Record<string, unknown>
  if (typeof p.version !== 'string' || p.version.length > 64 || !PKG_VERSION_RE.test(p.version)) return undefined
  if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) return undefined
  if (typeof p.path !== 'string' || !p.path.startsWith('/install/') || p.path.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(p.path) || p.path.includes('..')) return undefined
  return { version: p.version, sha256: p.sha256, path: p.path }
}

export function parseDiscoveryDoc(raw: unknown): CodeburnDiscoveryDoc {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DiscoveryError('Discovery doc must be a JSON object')
  }

  const doc = raw as Record<string, unknown>

  // Version check
  const version = typeof doc.version === 'number' ? doc.version : 1
  if (version > SUPPORTED_VERSION) {
    throw new DiscoveryError(
      `This endpoint requires codeburn sync v${version}. Please update codeburn.`
    )
  }

  const enrollment = doc.auth === 'enrollment'

  // Required fields (OIDC only: enrollment servers have no IdP)
  let issuer = ''
  let client_id = ''
  if (!enrollment) {
    if (typeof doc.issuer !== 'string' || !doc.issuer) {
      throw new DiscoveryError('Discovery doc missing required field: issuer')
    }
    issuer = doc.issuer

    if (typeof doc.client_id !== 'string' || !doc.client_id) {
      throw new DiscoveryError('Discovery doc missing required field: client_id')
    }
    client_id = doc.client_id

    // Format validation after presence checks (clearer errors)
    assertHttps(issuer, 'Issuer')
  } else {
    if (typeof doc.enroll_path !== 'string' || !doc.enroll_path.startsWith('/')) {
      throw new DiscoveryError('Discovery doc missing required field: enroll_path')
    }
  }

  // Optional with defaults
  const scopes = Array.isArray(doc.scopes)
    ? doc.scopes.filter((s): s is string => typeof s === 'string')
    : ['openid']

  const traces_path = typeof doc.traces_path === 'string' ? doc.traces_path : '/v1/traces'

  const max_batch_size = typeof doc.max_batch_size === 'number' && doc.max_batch_size > 0
    ? doc.max_batch_size
    : 1000

  const max_span_age_days = typeof doc.max_span_age_days === 'number' && Number.isFinite(doc.max_span_age_days) && doc.max_span_age_days > 0
    ? doc.max_span_age_days
    : undefined

  const levels = Array.isArray(doc.detail_levels)
    ? doc.detail_levels.filter((l): l is DetailLevel => l === 'summary' || l === 'sessions')
    : []
  const detail_levels: DetailLevel[] = levels.length > 0
    ? Array.from(new Set(levels))
    // Legacy OIDC endpoints predate detail levels and always received the full span set.
    : enrollment ? ['summary'] : ['summary', 'sessions']

  const client_package = enrollment ? parseClientPackage(doc.client_package) : undefined

  return {
    version, issuer, client_id, scopes, traces_path, max_batch_size, detail_levels,
    ...(max_span_age_days !== undefined ? { max_span_age_days } : {}),
    ...(enrollment ? { auth: 'enrollment' as const, enroll_path: doc.enroll_path as string } : {}),
    ...(enrollment && typeof doc.revoke_path === 'string' && doc.revoke_path.startsWith('/') ? { revoke_path: doc.revoke_path } : {}),
    ...(typeof doc.findings_path === 'string' && doc.findings_path.startsWith('/') ? { findings_path: doc.findings_path } : {}),
    ...(typeof doc.coaching_path === 'string' && doc.coaching_path.startsWith('/') ? { coaching_path: doc.coaching_path } : {}),
    ...(typeof doc.org_name === 'string' && doc.org_name ? { org_name: doc.org_name.slice(0, 200) } : {}),
    ...(client_package ? { client_package } : {}),
  }
}

export async function fetchDiscoveryDoc(baseUrl: string): Promise<CodeburnDiscoveryDoc> {
  assertHttps(baseUrl, 'Base URL')
  const url = `${baseUrl.replace(/\/$/, '')}/.well-known/codeburn-export.json`

  let response: Response
  try {
    response = await fetch(url)
  } catch (err) {
    throw new DiscoveryError(`Cannot reach ${url}: ${(err as Error).message}`)
  }

  if (response.status === 404) {
    throw new DiscoveryError(
      `Server does not support codeburn sync.\n${url} returned 404.`
    )
  }

  if (!response.ok) {
    throw new DiscoveryError(`${url} returned HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new DiscoveryError(`${url} returned invalid JSON`)
  }

  return parseDiscoveryDoc(body)
}

/**
 * Effective detail level: the client setting clamped to what the server
 * advertises. A server that accepts only "summary" always gets summary.
 */
export function effectiveDetailLevel(clientLevel: DetailLevel | undefined, serverLevels: readonly DetailLevel[] | undefined): DetailLevel {
  const allowed = serverLevels && serverLevels.length > 0 ? serverLevels : ['summary' as DetailLevel]
  const wanted = clientLevel ?? 'summary'
  return allowed.includes(wanted) ? wanted : 'summary'
}
