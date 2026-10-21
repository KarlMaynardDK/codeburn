import type { SpanRecord, Store } from './store.js'
import type { TeamServerConfig } from './config.js'

export const MAX_SPAN_AGE_DAYS = 183
export const MAX_FUTURE_MS = 86_400_000

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
  }
  return out
}

const str = (v: unknown, max: number, fallback: string): string => {
  if (typeof v !== 'string' || v.length === 0) return fallback
  return v.slice(0, max)
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const optInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)

export interface ParsedBatch {
  spans: SpanRecord[]
  /** Spans in the payload (any kind), used for the max_batch_size check. */
  total: number
  rejected: number
  ignored: number
  hasSessionLevel: boolean
  errorMessage?: string
}

/** Parses an OTLP/HTTP JSON payload into span records. Pure: no identity, no I/O. */
export function parseOtlp(payload: unknown, acceptSessionDetail: boolean, now = Date.now()): ParsedBatch {
  const out: ParsedBatch = { spans: [], total: 0, rejected: 0, ignored: 0, hasSessionLevel: false }
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
    for (const ss of Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : []) {
      for (const span of Array.isArray(ss?.spans) ? ss.spans : []) {
        out.total++
        const a = attrMap(span?.attributes)
        if (typeof a.get('ai.provider') !== 'string') { out.ignored++; continue }
        const spanId = span?.spanId
        let ms = NaN
        try { ms = Number(BigInt(String(span?.startTimeUnixNano)) / 1_000_000n) } catch { /* invalid */ }
        if (typeof spanId !== 'string' || !spanId || spanId.length > 64 || !Number.isFinite(ms)) {
          out.rejected++; firstError ??= 'malformed span'; continue
        }
        if (ms < minTs) { out.rejected++; firstError ??= `span older than ${MAX_SPAN_AGE_DAYS} days`; continue }
        if (ms > maxTs) { out.rejected++; firstError ??= 'span timestamp in the future'; continue }
        if (detail === 'sessions' && acceptSessionDetail) out.hasSessionLevel = true
        out.spans.push({
          span_id: spanId,
          trace_id: str(span?.traceId, 64, ''),
          ts: new Date(ms).toISOString(),
          provider: str(a.get('ai.provider'), 64, 'unknown'),
          model: str(a.get('ai.model'), 160, 'unknown'),
          project: str(a.get('ai.project'), 128, 'unknown'),
          category: str(a.get('ai.category'), 64, 'unknown'),
          input: Math.round(num(a.get('ai.input_tokens'))),
          output: Math.round(num(a.get('ai.output_tokens'))),
          cache_read: Math.round(num(a.get('ai.cache_read_tokens'))),
          cache_write: Math.round(num(a.get('ai.cache_write_tokens'))),
          cost_usd: num(a.get('ai.cost_usd')),
          detail_level: detail,
          // Session attributes survive only when the server accepts them AND the batch is sessions-level.
          work_unit_id: keepSession ? str(a.get('ai.work_unit_id'), 64, '') || null : null,
          session_role: keepSession ? str(a.get('ai.session_role'), 16, '') || null : null,
          call_count: keepSession ? optInt(a.get('ai.call_count')) : null,
          session_duration_ms: keepSession ? optInt(a.get('ai.session_duration_ms')) : null,
        })
      }
    }
  }
  if (firstError) out.errorMessage = firstError
  return out
}

export async function ingestOtlp(store: Store, cfg: TeamServerConfig, identity: { personId: string; deviceId: string }, payload: unknown) {
  const parsed = parseOtlp(payload, cfg.accept_session_detail)
  const { conflicts } = await store.ingestSpans(identity.personId, identity.deviceId, parsed.spans, cfg.accept_session_detail && parsed.hasSessionLevel)
  const rejected = parsed.rejected + conflicts
  return { total: parsed.total, rejected, errorMessage: parsed.errorMessage ?? (conflicts ? 'span id owned by another person' : undefined) }
}
