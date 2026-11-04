/**
 * The coaching snapshot a client uploads once a day (`codeburn sync coaching on`): counts it worked out locally from
 * prompts and edits it would never send. The server re-validates every field with an allow-list, so a modified client
 * can't store anything but numbers and a short period label.
 */

export interface CoachingSnapshot {
  period: { label: string | null; start: string | null; end: string | null }
  /** Prompts the person typed. */
  user_turns: number
  /** Follow-up prompts that told the assistant it got something wrong. */
  corrections: number
  sessions_with_edits: number
  /** Median time from a session's start to its first edit; null when no session edited. */
  median_time_to_first_edit_ms: number | null
  /** Rework across sessions, counts only (file names never leave the machine). */
  reworked_files: { files_in_3plus_sessions: number; max_sessions: number; max_edits: number }
}

const MAX_COUNT = 1_000_000_000

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_COUNT) : 0
}

function label(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40)
  return s || null
}

/** Null when `raw` is not an object. Everything else is clamped or dropped. */
export function parseCoaching(raw: unknown): CoachingSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const period = r.period && typeof r.period === 'object' ? r.period as Record<string, unknown> : {}
  const rework = r.reworked_files && typeof r.reworked_files === 'object' ? r.reworked_files as Record<string, unknown> : {}
  const ttfe = r.median_time_to_first_edit_ms
  return {
    period: { label: label(period.label), start: label(period.start), end: label(period.end) },
    user_turns: count(r.user_turns),
    corrections: Math.min(count(r.corrections), count(r.user_turns)),
    sessions_with_edits: count(r.sessions_with_edits),
    median_time_to_first_edit_ms: typeof ttfe === 'number' && Number.isFinite(ttfe) && ttfe >= 0 ? Math.min(Math.floor(ttfe), 86_400_000 * 30) : null,
    reworked_files: {
      files_in_3plus_sessions: count(rework.files_in_3plus_sessions),
      max_sessions: count(rework.max_sessions),
      max_edits: count(rework.max_edits),
    },
  }
}
