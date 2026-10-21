import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface TeamServerConfig {
  accept_session_detail: boolean
  accept_findings: boolean
  retention_days: number
  org_name: string
  /** Optional; the --database-url flag and CODEBURN_TEAM_DATABASE_URL take precedence. */
  database_url?: string
  /** Externally reachable base URL (https://codeburn.example.com), used in generated install scripts. */
  public_url?: string
}

/** Normalizes a configured public URL to scheme://host[:port] with no path; throws when it is not http(s). */
export function normalizePublicUrl(raw: string): string {
  let u: URL
  try { u = new URL(raw.trim()) } catch { throw new Error(`Invalid public URL: ${raw}`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`Public URL must be http(s): ${raw}`)
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new Error(`Public URL must be just scheme://host[:port]: ${raw}`)
  }
  return u.origin
}

export const DEFAULT_CONFIG: TeamServerConfig = {
  accept_session_detail: false,
  accept_findings: false,
  retention_days: 400,
  org_name: '',
}

export function resolveDataDir(flag?: string): string {
  const dir = resolve(flag ?? process.env.CODEBURN_TEAM_DATA_DIR ?? join(homedir(), '.codeburn-team'))
  mkdirSync(dir, { recursive: true })
  return dir
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false
  return undefined
}

/**
 * Environment overrides (CODEBURN_TEAM_ACCEPT_SESSION_DETAIL, CODEBURN_TEAM_ACCEPT_FINDINGS,
 * CODEBURN_TEAM_RETENTION_DAYS, CODEBURN_TEAM_ORG_NAME, CODEBURN_TEAM_PUBLIC_URL) win over team-server.json, so container
 * deployments can be configured without editing a file inside the data volume.
 */
function applyEnv(cfg: TeamServerConfig): TeamServerConfig {
  const session = envBool('CODEBURN_TEAM_ACCEPT_SESSION_DETAIL')
  if (session !== undefined) cfg.accept_session_detail = session
  const findings = envBool('CODEBURN_TEAM_ACCEPT_FINDINGS')
  if (findings !== undefined) cfg.accept_findings = findings
  const days = Number(process.env.CODEBURN_TEAM_RETENTION_DAYS)
  if (Number.isFinite(days) && days > 0) cfg.retention_days = Math.floor(days)
  const org = process.env.CODEBURN_TEAM_ORG_NAME
  if (org !== undefined && org !== '') cfg.org_name = org
  const publicUrl = process.env.CODEBURN_TEAM_PUBLIC_URL
  if (publicUrl !== undefined && publicUrl.trim() !== '') cfg.public_url = normalizePublicUrl(publicUrl)
  return cfg
}

/** Reads team-server.json, writing it with defaults when absent. Invalid fields fall back to defaults. */
export function loadConfig(dataDir: string): TeamServerConfig {
  const path = join(dataDir, 'team-server.json')
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8')
    return applyEnv({ ...DEFAULT_CONFIG })
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    throw new Error(`Invalid ${path}: ${(err as Error).message}`)
  }
  const cfg: TeamServerConfig = { ...DEFAULT_CONFIG }
  if (typeof raw.accept_session_detail === 'boolean') cfg.accept_session_detail = raw.accept_session_detail
  if (typeof raw.accept_findings === 'boolean') cfg.accept_findings = raw.accept_findings
  if (typeof raw.retention_days === 'number' && raw.retention_days > 0) cfg.retention_days = Math.floor(raw.retention_days)
  if (typeof raw.org_name === 'string') cfg.org_name = raw.org_name
  if (typeof raw.database_url === 'string' && raw.database_url) cfg.database_url = raw.database_url
  if (typeof raw.public_url === 'string' && raw.public_url.trim()) cfg.public_url = normalizePublicUrl(raw.public_url)
  return applyEnv(cfg)
}

export function resolveDatabaseUrl(flag: string | undefined, cfg: TeamServerConfig): string | undefined {
  return flag ?? process.env.CODEBURN_TEAM_DATABASE_URL ?? cfg.database_url
}
