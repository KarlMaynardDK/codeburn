import type { ParsedApiCall, SessionSummary } from './types.js'

// A mid-session model switch sends the whole conversation to a model whose
// cache holds none of it, so it is written to cache (or sent as input) again.
// Only switches that carried real context, landed while the old cache was
// still warm (a cold cache would have been rebuilt anyway), and were mostly
// uncached on the new model count.
export const MODEL_SWITCH_MIN_CARRIED_TOKENS = 20_000
const MODEL_SWITCH_MAX_READ_SHARE = 0.2
const MODEL_SWITCH_TTL_5M_MS = 5 * 60 * 1000
const MODEL_SWITCH_TTL_1H_MS = 60 * 60 * 1000

/// Normalise a model id so a date-stamped id and its alias, or two routes to
/// the same model, do not read as a switch.
function modelSwitchKey(model: string): string {
  return model.trim().toLowerCase().replace(/@.*$/, '').replace(/-\d{8}$/, '').replace(/^.*\//, '')
}

export type SessionModelSwitch = {
  /// The first call on the new model: the one that re-sent the context.
  call: ParsedApiCall
  from: string
  /// Prompt tokens the new model was sent without a cache hit (cache writes
  /// plus uncached input), capped at the previous call's prompt size so new
  /// turn content is not counted as carried context.
  carriedTokens: number
}

/// Every switch in one session, in call order, where the prior context was
/// re-sent to the new model instead of read from its cache. A session that
/// never reports cache tokens yields nothing: there a switch cannot be told
/// apart from an ordinary uncached call. Callers decide which sessions count
/// (subagent transcripts have a fresh context by design and should be skipped).
export function modelSwitchesInSession(session: SessionSummary): SessionModelSwitch[] {
  if (session.totalCacheReadTokens + session.totalCacheWriteTokens === 0) return []
  const out: SessionModelSwitch[] = []
  let prev: { key: string; model: string; at: number; prompt: number } | null = null
  let oneHourCache = false
  for (const turn of session.turns) {
    for (const call of turn.assistantCalls) {
      if (call.supplementaryAccounting || !call.model || call.model === '<synthetic>') continue
      const u = call.usage
      const prompt = u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
      const at = Date.parse(call.timestamp)
      const key = modelSwitchKey(call.model)
      if (prev && key !== prev.key && prompt > 0) {
        const ttl = oneHourCache ? MODEL_SWITCH_TTL_1H_MS : MODEL_SWITCH_TTL_5M_MS
        const warm = Number.isFinite(at) && Number.isFinite(prev.at) && at - prev.at <= ttl
        const carried = Math.min(u.inputTokens + u.cacheCreationInputTokens, prev.prompt)
        if (warm && carried >= MODEL_SWITCH_MIN_CARRIED_TOKENS && u.cacheReadInputTokens <= prompt * MODEL_SWITCH_MAX_READ_SHARE) {
          out.push({ call, from: prev.model, carriedTokens: carried })
        }
      }
      if ((call.cacheCreationOneHourTokens ?? 0) > 0) oneHourCache = true
      prev = { key, model: call.model, at, prompt }
    }
  }
  return out
}
