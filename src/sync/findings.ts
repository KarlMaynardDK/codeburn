/**
 * codeburn sync — optimize findings upload.
 *
 * After a successful usage push, when the user opted in and the server
 * advertises findings_path, POST the same data `codeburn optimize --format json`
 * prints. At most once per UTC day (config.lastFindingsSent).
 */

import { assertHttps } from './discovery.js'
import { readSyncConfig, writeSyncConfig, type SyncConfig } from './config.js'

export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function findingsDue(config: SyncConfig, findingsPath: string | undefined, now: number = Date.now()): boolean {
  return config.shareFindings === true && !!findingsPath && config.lastFindingsSent !== utcDay(now)
}

/** Same data as `codeburn optimize --format json` (default 30-day window), built in-process. */
export async function buildFindingsReport(): Promise<unknown> {
  const { loadPricing } = await import('../models.js')
  const { parseAllSessions } = await import('../parser.js')
  const { getDateRange } = await import('../cli-date.js')
  const { scanAndDetect, buildOptimizeJsonReport } = await import('../optimize.js')
  await loadPricing()
  const { range, label } = getDateRange('30days')
  const projects = await parseAllSessions(range, 'all')
  const result = await scanAndDetect(projects, range, 'all')
  return buildOptimizeJsonReport(projects, label, result, range)
}

const PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w.:])\/(?=[\w.~-]))[^\s"'`,;)\]]*/g

/** Replace anything path-shaped in free text. */
export function scrubPaths(text: string): string {
  return text.replace(PATH_RE, '<path>').replace(/\S*\\\S*/g, '<path>').slice(0, 200)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown, max = 40): string | null => (typeof v === 'string' ? scrubPaths(v).slice(0, max) : null)

/**
 * Explicit allow-list of the optimize JSON report. Everything else (fix
 * commands, explanations, reworked file names, coaching notes, applied fixes,
 * model recommendations) is dropped: they can embed file paths or turn content.
 */
export function sanitizeFindingsReport(report: unknown): unknown {
  const r = (report ?? {}) as Record<string, any>
  const summary = (r.summary ?? {}) as Record<string, unknown>
  const period = (r.period ?? {}) as Record<string, unknown>
  const findings = Array.isArray(r.findings) ? r.findings : []
  return {
    period: { label: str(period.label), start: str(period.start), end: str(period.end) },
    summary: {
      healthScore: num(summary.healthScore),
      healthGrade: str(summary.healthGrade, 2),
      findingCount: num(summary.findingCount),
      periodCostUSD: num(summary.periodCostUSD),
      potentialSavingsTokens: num(summary.potentialSavingsTokens),
      potentialSavingsCostUSD: num(summary.potentialSavingsCostUSD),
    },
    findings: findings.map((f: Record<string, unknown>) => ({
      id: str(f.id, 64),
      title: str(f.title, 200),
      severity: str(f.severity, 16),
      trend: str(f.trend, 16),
      class: str(f.class, 16),
      basis: str(f.basis, 16),
      tokensSaved: num(f.tokensSaved),
      estimatedSavingsUSD: num(f.estimatedSavingsUSD),
    })),
  }
}

export type FindingsOutcome = 'sent' | 'skipped' | 'unauthorized' | 'failed'

export interface SendFindingsOptions {
  config: SyncConfig
  /** findings_path from the live discovery doc (falls back to config). */
  findingsPath: string | undefined
  bearer: string
  now?: number
  log?: (msg: string) => void
  /** Test seam; defaults to buildFindingsReport. */
  buildReport?: () => Promise<unknown>
}

export async function maybeSendFindings(opts: SendFindingsOptions): Promise<FindingsOutcome> {
  const now = opts.now ?? Date.now()
  const log = opts.log ?? (() => {})
  const findingsPath = opts.findingsPath ?? opts.config.findingsPath
  if (!findingsDue(opts.config, findingsPath, now)) return 'skipped'

  const url = `${opts.config.baseUrl}${findingsPath}`
  try {
    assertHttps(url, 'Findings endpoint')
    const findings = sanitizeFindingsReport(await (opts.buildReport ?? buildFindingsReport)())
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.bearer}` },
      body: JSON.stringify({ captured_at: new Date(now).toISOString(), findings }),
    })
    if (response.status === 401) {
      log('Findings upload rejected (401).')
      return 'unauthorized'
    }
    if (!response.ok) {
      log(`Findings upload failed (HTTP ${response.status}); will retry on the next push.`)
      return 'failed'
    }
    // Re-read: the push may have rewritten config since the caller loaded it.
    const fresh = readSyncConfig()
    if (fresh) writeSyncConfig({ ...fresh, lastFindingsSent: utcDay(now) })
    log('Findings uploaded.')
    return 'sent'
  } catch (err) {
    log(`Findings upload failed: ${(err as Error).message}`)
    return 'failed'
  }
}
