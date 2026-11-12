import type { SpanRecord, Store, WorkCommitRecord, WorkSessionRecord } from './store.js'
import type { TeamServerConfig } from './config.js'

export const MAX_SPAN_AGE_DAYS = 183
export const MAX_FUTURE_MS = 86_400_000
/** Names kept per list attribute (ai.mcp_tools, ai.skills, ai.subagent_types, git.pr_links). */
export const MAX_NAMES = 64

/** Span names of the git attribution spans `codeburn sync push --attribution` sends (src/sync/otlp.ts). */
const SESSION_ATTRIBUTION_SPAN = 'codeburn.session.attribution'
const COMMIT_ATTRIBUTION_SPAN = 'codeburn.commit'

type AnyAttr = { key?: unknown; value?: Record<string, unknown> }

function attrMap(attrs: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (!Array.isArray(attrs)) return out
  for (const a of attrs as AnyAttr[]) {
    if (!a || typeof a.key !== 'string' || !a.value || typeof a.value !== 'object') continue
    const v = a.value
    if ('stringValue' in v) out.set(a.key, v.stringValue)
    else if ('intValue' in v) out.set(a.key, Number(v.intValue))
    else if ('doubleValue' in v) out.set(a.key, Number(v.doubleValue))
    else if ('boolValue' in v) out.set(a.key, v.boolValue)
    else if ('arrayValue' in v) {
      const values = (v.arrayValue as { values?: unknown } | null)?.values
      out.set(a.key, Array.isArray(values)
        ? values.map(x => (x as { stringValue?: unknown } | null)?.stringValue).filter((x): x is string => typeof x === 'string')
        : [])
    }
  }
  return out
}

const str = (v: unknown, max: number, fallback: string): string => {
  if (typeof v !== 'string' || v.length === 0) return fallback
  return v.slice(0, max)
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const int = (v: unknown): number => Math.round(num(v))
const optInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
const flag = (v: unknown): boolean => v === true
// eslint-disable-next-line no-control-regex
const names = (v: unknown, max = 128): string[] => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x)))].slice(0, MAX_NAMES) : [])

function spanMs(span: { startTimeUnixNano?: unknown } | undefined): number {
  try { return Number(BigInt(String(span?.startTimeUnixNano)) / 1_000_000n) } catch { return NaN }
}

export interface ParsedBatch {
  spans: SpanRecord[]
  /** Git attribution, kept only when the server accepts session detail. */
  workSessions: WorkSessionRecord[]
  workCommits: WorkCommitRecord[]
  /** Latest codeburn.coverage_through date in the payload. */
  coverageThrough?: string
  /** Spans in the payload (any kind), used for the max_batch_size check. */
  total: number
  rejected: number
  ignored: number
  hasSessionLevel: boolean
  errorMessage?: string
}

/** Parses an OTLP/HTTP JSON payload into span records. Pure: no identity, no I/O. */
export function parseOtlp(payload: unknown, acceptSessionDetail: boolean, now = Date.now()): ParsedBatch {
  const out: ParsedBatch = { spans: [], workSessions: [], workCommits: [], total: 0, rejected: 0, ignored: 0, hasSessionLevel: false }
  const resourceSpans = (payload as { resourceSpans?: unknown })?.resourceSpans
  if (!Array.isArray(resourceSpans)) return out
  const minTs = now - MAX_SPAN_AGE_DAYS * 86_400_000
  const maxTs = now + MAX_FUTURE_MS
  let firstError: string | undefined

  for (const rs of resourceSpans) {
    const res = attrMap(rs?.resource?.attributes)
    // Missing level means a legacy client, which sent full detail.
    const detail: 'summary' | 'sessions' = res.get('codeburn.detail_level') === 'summary' ? 'summary' : 'sessions'
    const keepSession = acceptSessionDetail && detail === 'sessions'
    const coverage = res.get('codeburn.coverage_through')
    if (typeof coverage === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(coverage) && (!out.coverageThrough || coverage > out.coverageThrough)) {
      out.coverageThrough = coverage
    }
    for (const ss of Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : []) {
      for (const span of Array.isArray(ss?.spans) ? ss.spans : []) {
        out.total++
        const a = attrMap(span?.attributes)
        if (typeof a.get('ai.provider') !== 'string') {
          // Attribution spans carry session ids and git facts, so they follow the session-detail switch.
          if (keepSession && span?.name === SESSION_ATTRIBUTION_SPAN && parseWorkSession(span, a, out)) continue
          if (keepSession && span?.name === COMMIT_ATTRIBUTION_SPAN && parseWorkCommit(span, a, out)) continue
          out.ignored++
          continue
        }
        const spanId = span?.spanId
        const ms = spanMs(span)
        if (typeof spanId !== 'string' || !spanId || spanId.length > 64 || !Number.isFinite(ms)) {
          out.rejected++; firstError ??= 'malformed span'; continue
        }
        if (ms < minTs) { out.rejected++; firstError ??= `span older than ${MAX_SPAN_AGE_DAYS} days`; continue }
        if (ms > maxTs) { out.rejected++; firstError ??= 'span timestamp in the future'; continue }
        if (detail === 'sessions' && acceptSessionDetail) out.hasSessionLevel = true
        const weight = a.get('ai.request_weight')
        out.spans.push({
          span_id: spanId,
          trace_id: str(span?.traceId, 64, ''),
          ts: new Date(ms).toISOString(),
          provider: str(a.get('ai.provider'), 64, 'unknown'),
          model: str(a.get('ai.model'), 160, 'unknown'),
          project: str(a.get('ai.project'), 128, 'unknown'),
          category: str(a.get('ai.category'), 64, 'unknown'),
          input: int(a.get('ai.input_tokens')),
          output: int(a.get('ai.output_tokens')),
          cache_read: int(a.get('ai.cache_read_tokens')),
          cache_write: int(a.get('ai.cache_write_tokens')),
          cost_usd: num(a.get('ai.cost_usd')),
          detail_level: detail,
          // Session attributes survive only when the server accepts them AND the batch is sessions-level.
          work_unit_id: keepSession ? str(a.get('ai.work_unit_id'), 64, '') || null : null,
          session_role: keepSession ? str(a.get('ai.session_role'), 16, '') || null : null,
          call_count: keepSession ? optInt(a.get('ai.call_count')) : null,
          session_duration_ms: keepSession ? optInt(a.get('ai.session_duration_ms')) : null,
          speed: str(a.get('ai.speed'), 16, 'unknown'),
          route: str(a.get('ai.billing_route'), 32, ''),
          billing: a.get('ai.billing_mode') === 'metered' || a.get('ai.billing_mode') === 'subscription' ? a.get('ai.billing_mode') as string : '',
          cost_estimated: flag(a.get('ai.cost_estimated')),
          subscription_covered: flag(a.get('ai.subscription_covered')),
          reasoning: int(a.get('ai.reasoning_tokens')),
          web_search: int(a.get('ai.web_search_requests')),
          cache_write_1h: int(a.get('ai.cache_write_1h_tokens')),
          savings_usd: num(a.get('ai.savings_usd')),
          nano_aiu: int(a.get('ai.nano_aiu')),
          // Absent means one request; 0 marks supplementary accounting that adds cost but no call.
          request_weight: typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 ? Math.min(Math.round(weight), 1_000_000) : 1,
          lines_added: int(a.get('ai.lines_added')),
          lines_removed: int(a.get('ai.lines_removed')),
          tool_errors: int(a.get('ai.tool_errors')),
          interrupted: flag(a.get('ai.interrupted')),
          user_modified: flag(a.get('ai.user_modified')),
          active_ms: int(a.get('ai.active_duration_ms')),
          tool_wait_ms: int(a.get('ai.tool_wait_ms')),
          turn_start: flag(a.get('ai.turn_start')),
          turn_has_edits: flag(a.get('ai.turn_has_edits')),
          turn_retries: int(a.get('ai.turn_retries')),
          plan_mode: flag(a.get('ai.plan_mode')),
          mcp_tools: names(a.get('ai.mcp_tools')),
          skills: names(a.get('ai.skills')),
          subagent_types: names(a.get('ai.subagent_types')),
          model_switch_tokens: int(a.get('ai.model_switch_tokens')),
        })
      }
    }
  }
  if (firstError) out.errorMessage = firstError
  return out
}

type RawSpan = { traceId?: unknown; startTimeUnixNano?: unknown; endTimeUnixNano?: unknown }

function attributionBase(span: RawSpan, a: Map<string, unknown>): { trace_id: string; repo: string; ms: number } | null {
  const trace = span?.traceId
  const repo = a.get('git.repo')
  const ms = spanMs(span)
  if (typeof trace !== 'string' || !trace || trace.length > 64 || typeof repo !== 'string' || !repo || !Number.isFinite(ms)) return null
  return { trace_id: trace, repo: repo.slice(0, 256), ms }
}

function parseWorkSession(span: RawSpan, a: Map<string, unknown>, out: ParsedBatch): boolean {
  const base = attributionBase(span, a)
  if (!base) return false
  const end = spanMs({ startTimeUnixNano: span.endTimeUnixNano })
  out.workSessions.push({
    trace_id: base.trace_id,
    repo: base.repo,
    project: str(a.get('ai.project'), 128, 'unknown'),
    started: new Date(base.ms).toISOString(),
    ended: new Date(Number.isFinite(end) && end >= base.ms ? end : base.ms).toISOString(),
    commit_count: int(a.get('git.commit_count')),
    pr_links: names(a.get('git.pr_links'), 512).filter(u => /^https:\/\//.test(u)),
  })
  return true
}

function parseWorkCommit(span: RawSpan, a: Map<string, unknown>, out: ParsedBatch): boolean {
  const base = attributionBase(span, a)
  const sha = a.get('git.sha')
  if (!base || typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha)) return false
  out.workCommits.push({
    trace_id: base.trace_id,
    repo: base.repo,
    sha: sha.toLowerCase(),
    ts: new Date(base.ms).toISOString(),
    in_main: flag(a.get('git.in_main')),
    was_reverted: flag(a.get('git.was_reverted')),
  })
  return true
}

export async function ingestOtlp(store: Store, cfg: TeamServerConfig, identity: { personId: string; deviceId: string }, payload: unknown) {
  const parsed = parseOtlp(payload, cfg.accept_session_detail)
  const { conflicts } = await store.ingestSpans(identity.personId, identity.deviceId, parsed.spans, cfg.accept_session_detail && parsed.hasSessionLevel)
  await store.ingestAttribution(identity.personId, parsed.workSessions, parsed.workCommits)
  if (parsed.coverageThrough) await store.setCoverage(identity.deviceId, parsed.coverageThrough)
  const rejected = parsed.rejected + conflicts
  return { total: parsed.total, rejected, errorMessage: parsed.errorMessage ?? (conflicts ? 'span id owned by another person' : undefined) }
}
