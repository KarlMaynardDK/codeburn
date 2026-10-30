/**
 * codeburn sync - consent-once auto-sync with fingerprint and receipts.
 *
 * Manages acceptance fingerprints, disclosure building, and receipt tracking
 * for automatic scheduled pushes.
 */

import { createHash } from 'crypto'

export const WIRE_CONTRACT_VERSION = 'v2'

export const CORE_SYNC_FIELD_MEANINGS: ReadonlyMap<string, string> = new Map([
  ['ai.provider', 'which AI service handled the call'],
  ['ai.model', 'which AI model handled the call'],
  ['ai.input_tokens', 'tokens sent to the model'],
  ['ai.output_tokens', 'tokens returned by the model'],
  ['ai.cost_usd', 'the cost of the call in US dollars'],
  ['ai.speed', 'the service tier of the call (standard, fast or flex)'],
  ['ai.project', 'directory name of the project'],
  ['ai.tools', 'tools available to the model'],
  ['ai.cost_estimated', 'whether cost was estimated or billed'],
  ['ai.work_unit_id', 'internal task identifier (only when work matching is on)'],
  ['ai.session_role', 'type of usage (development, production, etc.)'],
  ['ai.lineage_evidence', 'evidence linking the session to a task (only when work matching is on)'],
  ['ai.cache_read_tokens', 'tokens read from cache'],
  ['ai.cache_write_tokens', 'tokens written to cache'],
  ['ai.call_count', 'how many API requests in the session'],
  ['ai.session_duration_ms', 'how long the session lasted in milliseconds'],
  ['ai.category', 'the kind of task (coding, debugging, testing, ...)'],
  ['codeburn.detail_level', 'whether per-session detail (summary or sessions) is sent'],
  ['ai.subscription_covered', 'whether usage is covered by subscription'],
  ['codeburn.device_id', 'a stable random identifier for this device'],
  ['codeburn.coverage_through', 'date through which usage has been analyzed'],
  ['codeburn.attribution_methodology', 'how session-to-task links were inferred'],
  ['git.repo', 'repository name (only when work matching is on)'],
  ['git.sha', 'commit hash (only when work matching is on)'],
  ['git.commit_count', 'number of commits in the session (only when work matching is on)'],
  ['git.in_main', 'whether commits were to the main branch (only when work matching is on)'],
  ['git.was_reverted', 'whether work was reverted (only when work matching is on)'],
  ['git.pr_links', 'pull request URLs (only when work matching is on)'],
  ['ai.reasoning_tokens', 'reasoning tokens the provider recorded'],
  ['ai.web_search_requests', 'how many web searches the call made'],
  ['ai.cache_write_1h_tokens', 'tokens written to the one-hour cache'],
  ['ai.savings_usd', 'what a local model call would have cost on a paid model, in US dollars'],
  ['ai.billing_route', 'the billing route (for example bedrock or vertex)'],
  ['ai.billing_mode', 'whether the call was metered or subscription-billed'],
  ['ai.nano_aiu', 'GitHub Copilot credits used, in nano-units'],
  ['ai.request_weight', 'how many requests the record stands for, when not one'],
  ['ai.lines_added', 'how many lines the call added'],
  ['ai.lines_removed', 'how many lines the call removed'],
  ['ai.tool_errors', 'how many tool calls failed'],
  ['ai.interrupted', 'whether you interrupted the call'],
  ['ai.user_modified', 'whether you changed an edit the call proposed'],
  ['ai.active_duration_ms', 'how long the model was generating, in milliseconds'],
  ['ai.tool_wait_ms', 'how long tools ran, in milliseconds'],
  ['ai.turn_start', 'marks the first call of a prompt'],
  ['ai.turn_has_edits', 'whether the prompt led to file edits'],
  ['ai.turn_retries', 'how many retries the prompt needed'],
  ['ai.mcp_tools', 'names of the MCP tools the call used'],
  ['ai.skills', 'names of the skills the call used'],
  ['ai.subagent_types', 'types of subagents the call started'],
  ['ai.plan_mode', 'whether the call used plan mode'],
])

export interface FingerprintInput {
  org: string
  destination: string
  outboundFields: string[]
  workMatching: boolean
  scopeSinceDays: number | null
  cadence: 'daily' | 'hourly'
  /**
   * Effective wire detail level (client setting clamped to the server).
   * Absent means the legacy wire from before detail levels existed: the full
   * span set with no codeburn.detail_level stamp. Acceptances stored before
   * this field existed have it absent for that reason.
   */
  detailLevel?: 'summary' | 'sessions'
  /** Whether optimize findings are uploaded after a push. Default false. */
  shareFindings?: boolean
}

export function computeAcceptanceFingerprint(input: FingerprintInput): string {
  const canonical = {
    org: input.org,
    destination: input.destination,
    contractVersion: WIRE_CONTRACT_VERSION,
    outboundFields: [...input.outboundFields].sort(),
    workMatching: input.workMatching,
    scopeSinceDays: input.scopeSinceDays,
    cadence: input.cadence,
  }
  // The legacy wire with findings off hashes exactly as before these fields
  // existed, so acceptances stored by older versions keep matching.
  if (input.detailLevel !== undefined || input.shareFindings) {
    Object.assign(canonical, {
      detailLevel: input.detailLevel,
      shareFindings: input.shareFindings ?? false,
    })
  }
  const json = JSON.stringify(canonical)
  return createHash('sha256').update(json).digest('hex')
}

export interface DisclosureInput {
  destination: string
  destinationUrl: string
  cadence: 'daily' | 'hourly'
  outboundFields: Array<{ key: string; disclosure: string }>
  workMatching: boolean
  scopeSinceDays: number | null
  detailLevel?: 'summary' | 'sessions'
  shareFindings?: boolean
}

export function buildDisclosure(input: DisclosureInput): string {
  const cadenceText = input.cadence === 'daily' ? 'once per day' : 'once per hour'
  const scopeText = input.scopeSinceDays === null
    ? 'full history (up to 6 months)'
    : input.scopeSinceDays === 0
      ? 'today only'
      : `last ${input.scopeSinceDays} days`
  const workMatchingText = input.workMatching
    ? 'on - session-to-commit links are sent'
    : 'off'

  const detailText = input.detailLevel === undefined
    ? 'full - calls carry session ids, durations, call counts and tools, exact timestamps'
    : input.detailLevel === 'sessions'
      ? 'sessions - calls carry session ids, durations, call counts and tools, exact timestamps'
      : 'summary - usage, counts and MCP tool, skill and subagent names only: per-day buckets, hour-rounded times, no session grouping'
  const findingsText = input.shareFindings
    ? 'on - a daily snapshot of `codeburn optimize` findings is uploaded: finding id, title, severity, trend, estimated savings (tokens and USD) and period totals only; never file paths, file names, commands, snippets or explanations'
    : 'off'

  const fieldsList = input.outboundFields.length > 0
    ? input.outboundFields
      .map(f => `  ${f.key}: ${f.disclosure}`)
      .join('\n')
    : '  (no fields)'

  return [
    `Destination: ${input.destination}`,
    `URL: ${input.destinationUrl}`,
    `Cadence: ${cadenceText}`,
    `Scope: ${scopeText}`,
    `Work matching: ${workMatchingText}`,
    `Detail level: ${detailText}`,
    `Share findings: ${findingsText}`,
    '',
    'Data sent to the endpoint:',
    fieldsList,
    '',
    'Data that stays local:',
    '  raw prompts (never sent)',
    '  file paths (only project basename sent)',
    '  provider configuration files',
    '',
    'You can stop automatic sync at any time with: codeburn sync auto disable',
    'Any change to what would be sent requires your acceptance again before an automatic push runs.',
  ].join('\n')
}

export interface AcceptanceRecord {
  fingerprint: string
  acceptedAt: string
  cadence: 'daily' | 'hourly'
  disclosure: string
  attribution: boolean
  input?: FingerprintInput
}

export interface AutoSyncConfig {
  accepted?: AcceptanceRecord
  killed?: boolean
  lastRun?: {
    at: string
    result: string
  }
}

export type ReceiptResult =
  | { result: 'killed' }
  | { result: 'not-accepted' }
  | { result: 'acceptance-required'; changed: string[] }
  | { result: 'pushed'; spans: number }
  | { result: 'error'; reason: string }

export interface Receipt {
  at: string
  fingerprint?: string
  result: string
  [key: string]: unknown
}

export function buildReceipt(at: string, fingerprint: string | undefined, data: ReceiptResult): Receipt {
  return {
    at,
    ...(fingerprint && { fingerprint }),
    ...data,
  }
}

export function detectFingerprintChanges(stored: FingerprintInput | undefined, current: FingerprintInput): string[] {
  if (!stored) return ['unknown']

  const changes: string[] = []

  if (stored.destination !== current.destination) {
    changes.push('destination')
  }

  if (stored.cadence !== current.cadence) {
    changes.push('cadence')
  }

  if (stored.scopeSinceDays !== current.scopeSinceDays) {
    changes.push('scope')
  }

  if (stored.workMatching !== current.workMatching) {
    changes.push('work matching')
  }

  if (stored.detailLevel !== current.detailLevel) {
    changes.push('detail level')
  }

  if ((stored.shareFindings ?? false) !== (current.shareFindings ?? false)) {
    changes.push('findings sharing')
  }

  const storedFields = new Set(stored.outboundFields)
  const currentFields = new Set(current.outboundFields)
  const added = Array.from(currentFields).filter(f => !storedFields.has(f)).sort()
  const removed = Array.from(storedFields).filter(f => !currentFields.has(f)).sort()

  if (added.length > 0 || removed.length > 0) {
    const parts: string[] = []
    if (added.length > 0) parts.push(`added: ${added.join(', ')}`)
    if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`)
    changes.push(`field set (${parts.join(' / ')})`)
  }

  return changes.length > 0 ? changes : ['unknown']
}

/**
 * True when `current` differs from `stored` only by sending LESS: a lower
 * detail level and/or findings turned off. Such a change needs no new consent.
 */
export function isReductionOnly(stored: FingerprintInput | undefined, current: FingerprintInput): boolean {
  if (!stored) return false
  // Absent is the legacy full span set, which sends as much as sessions.
  const rank = (l: 'summary' | 'sessions' | undefined): number => (l === 'summary' ? 0 : 1)
  if (rank(current.detailLevel) > rank(stored.detailLevel)) return false
  if ((current.shareFindings ?? false) && !(stored.shareFindings ?? false)) return false
  const same: FingerprintInput = {
    ...current,
    detailLevel: stored.detailLevel,
    shareFindings: stored.shareFindings,
  }
  return computeAcceptanceFingerprint(same) === computeAcceptanceFingerprint(stored)
}
