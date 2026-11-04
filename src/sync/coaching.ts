/**
 * codeburn sync — coaching snapshot upload.
 *
 * After a successful usage push, when the user opted in and the server
 * advertises coaching_path, POST a few workflow numbers computed locally from
 * the same functions `codeburn report` uses. Only counts leave the machine:
 * never prompt text, file names or paths. At most once per UTC day
 * (config.lastCoachingSent).
 */

import { assertHttps } from './discovery.js'
import { currentCliVersion } from '../plugins/loader.js'
import { readSyncConfig, writeSyncConfig, type SyncConfig } from './config.js'
import { scrubPaths, utcDay } from './findings.js'
import { userStartedProjects } from '../session-population.js'
import { aggregateFileChurn, medianTimeToFirstEditMs, scanUserCorrections, sessionTimeToFirstEditMs } from '../workflow-insights.js'
import type { ProjectSummary } from '../types.js'

/** A file counts as reworked when edits touched it in at least this many sessions (matches the coaching note). */
export const REWORK_MIN_SESSIONS = 3

export interface CoachingSnapshot {
  period: { label: string | null; start: string | null; end: string | null }
  user_turns: number
  corrections: number
  sessions_with_edits: number
  median_time_to_first_edit_ms: number | null
  reworked_files: { files_in_3plus_sessions: number; max_sessions: number; max_edits: number }
}

export function coachingDue(config: SyncConfig, coachingPath: string | undefined, now: number = Date.now()): boolean {
  return config.shareCoaching === true && !!coachingPath && config.lastCoachingSent !== utcDay(now)
}

/** Numbers only: everything is derived by the same functions the local report uses, then reduced to counts. */
export function summarizeCoaching(projects: ProjectSummary[], period: { label?: string; start?: string; end?: string } = {}): CoachingSnapshot {
  const corrections = scanUserCorrections(projects)
  let sessionsWithEdits = 0
  for (const project of userStartedProjects(projects)) {
    for (const session of project.sessions) {
      if (sessionTimeToFirstEditMs(session) !== null) sessionsWithEdits++
    }
  }
  const churn = aggregateFileChurn(projects, Number.MAX_SAFE_INTEGER)
  return {
    period: { label: period.label ?? null, start: period.start ?? null, end: period.end ?? null },
    user_turns: corrections.userTurns,
    corrections: corrections.corrections,
    sessions_with_edits: sessionsWithEdits,
    median_time_to_first_edit_ms: medianTimeToFirstEditMs(projects),
    reworked_files: {
      files_in_3plus_sessions: churn.filter(f => f.sessions >= REWORK_MIN_SESSIONS).length,
      max_sessions: churn.reduce((m, f) => Math.max(m, f.sessions), 0),
      max_edits: churn.reduce((m, f) => Math.max(m, f.edits), 0),
    },
  }
}

/** Same 30-day window as the findings snapshot, built in-process. */
export async function buildCoachingReport(): Promise<unknown> {
  const { loadPricing } = await import('../models.js')
  const { parseAllSessions } = await import('../parser.js')
  const { getDateRange } = await import('../cli-date.js')
  await loadPricing()
  const { range, label } = getDateRange('30days')
  const projects = await parseAllSessions(range, 'all')
  return summarizeCoaching(projects, {
    label,
    start: range.start instanceof Date ? range.start.toISOString().slice(0, 10) : undefined,
    end: range.end instanceof Date ? range.end.toISOString().slice(0, 10) : undefined,
  })
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : null)
const str = (v: unknown, max = 40): string | null => (typeof v === 'string' ? scrubPaths(v).slice(0, max) : null)

/** Explicit allow-list: anything not named here is dropped, numbers are clamped to finite and >= 0. */
export function sanitizeCoachingReport(report: unknown): CoachingSnapshot {
  const r = (report ?? {}) as Record<string, any>
  const period = (r.period ?? {}) as Record<string, unknown>
  const rework = (r.reworked_files ?? {}) as Record<string, unknown>
  return {
    period: { label: str(period.label), start: str(period.start), end: str(period.end) },
    user_turns: num(r.user_turns),
    corrections: num(r.corrections),
    sessions_with_edits: num(r.sessions_with_edits),
    median_time_to_first_edit_ms: optNum(r.median_time_to_first_edit_ms),
    reworked_files: {
      files_in_3plus_sessions: num(rework.files_in_3plus_sessions),
      max_sessions: num(rework.max_sessions),
      max_edits: num(rework.max_edits),
    },
  }
}

export type CoachingOutcome = 'sent' | 'skipped' | 'unauthorized' | 'failed'

export interface SendCoachingOptions {
  config: SyncConfig
  /** coaching_path from the live discovery doc (falls back to config). */
  coachingPath: string | undefined
  bearer: string
  now?: number
  log?: (msg: string) => void
  /** Test seam; defaults to buildCoachingReport. */
  buildReport?: () => Promise<unknown>
}

export async function maybeSendCoaching(opts: SendCoachingOptions): Promise<CoachingOutcome> {
  const now = opts.now ?? Date.now()
  const log = opts.log ?? (() => {})
  const coachingPath = opts.coachingPath ?? opts.config.coachingPath
  if (!coachingDue(opts.config, coachingPath, now)) return 'skipped'

  const url = `${opts.config.baseUrl}${coachingPath}`
  try {
    assertHttps(url, 'Coaching endpoint')
    const coaching = sanitizeCoachingReport(await (opts.buildReport ?? buildCoachingReport)())
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.bearer}`, 'X-Codeburn-Client-Version': currentCliVersion() },
      body: JSON.stringify({ captured_at: new Date(now).toISOString(), coaching }),
    })
    if (response.status === 401) {
      log('Coaching upload rejected (401).')
      return 'unauthorized'
    }
    if (!response.ok) {
      log(`Coaching upload failed (HTTP ${response.status}); will retry on the next push.`)
      return 'failed'
    }
    // Re-read: the push may have rewritten config since the caller loaded it.
    const fresh = readSyncConfig()
    if (fresh) writeSyncConfig({ ...fresh, lastCoachingSent: utcDay(now) })
    log('Coaching stats uploaded.')
    return 'sent'
  } catch (err) {
    log(`Coaching upload failed: ${(err as Error).message}`)
    return 'failed'
  }
}
