/**
 * Per-call counts, flags and names carried on a detail-level wire (team
 * servers): present at summary and sessions, absent from the legacy OIDC wire.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildOtlpPayload, CORE_SYNC_ATTRIBUTE_KEYS, DETAIL_LEVEL_ONLY_KEYS, type CallWithSession } from '../src/sync/otlp.js'
import { CORE_SYNC_FIELD_MEANINGS } from '../src/sync/consent.js'
import type { ParsedApiCall, ProjectSummary } from '../src/types.js'
import { setHome } from './setup/home.js'

function call(overrides: Partial<ParsedApiCall> = {}): ParsedApiCall {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
    costUSD: 0.01,
    tools: ['Edit'],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-08-24T10:00:00.000Z',
    bashCommands: ['rm -rf /tmp/secret'],
    deduplicationKey: 'detail-call-1',
    ...overrides,
  }
}

const rich = (): CallWithSession => ({
  call: call({
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 3, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 40, webSearchRequests: 2 },
    cacheCreationOneHourTokens: 3,
    savingsUSD: 0.25,
    nanoAiu: 5_000,
    locAdded: 12,
    locRemoved: 3,
    toolErrors: 1,
    interrupted: true,
    userModified: true,
    activeDurationMs: 1_500,
    toolWaitMs: 800,
    hasPlanMode: true,
    isEstimated: true,
    mcpTools: ['mcp__github__create_pr', 'mcp__github__create_pr', '/Users/alice/secret'],
    skills: ['anthropic-skills:docx'],
    subagentTypes: ['Explore'],
    billing: 'subscription',
  }),
  sessionId: 'detail-session-1',
  workingDirectory: '/Users/alice/work/widget',
  category: 'coding',
  turn: { hasEdits: true, retries: 2 },
  session: { callCount: 3, subscriptionCovered: true },
})

function attrs(item: CallWithSession, detailLevel?: 'summary' | 'sessions'): Record<string, unknown> {
  const span = buildOtlpPayload([item], detailLevel ? { detailLevel } : undefined).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
  return Object.fromEntries(span.attributes.map(a => [a.key, a.value]))
}

describe('detail-level call fields', () => {
  it('carries counts, flags and names at summary', () => {
    const a = attrs(rich(), 'summary')
    expect(a).toMatchObject({
      'ai.reasoning_tokens': { intValue: '40' },
      'ai.web_search_requests': { intValue: '2' },
      'ai.cache_write_1h_tokens': { intValue: '3' },
      'ai.savings_usd': { doubleValue: 0.25 },
      'ai.nano_aiu': { intValue: '5000' },
      'ai.lines_added': { intValue: '12' },
      'ai.lines_removed': { intValue: '3' },
      'ai.tool_errors': { intValue: '1' },
      'ai.interrupted': { boolValue: true },
      'ai.user_modified': { boolValue: true },
      'ai.active_duration_ms': { intValue: '1500' },
      'ai.tool_wait_ms': { intValue: '800' },
      'ai.turn_start': { boolValue: true },
      'ai.turn_has_edits': { boolValue: true },
      'ai.turn_retries': { intValue: '2' },
      'ai.plan_mode': { boolValue: true },
      'ai.billing_mode': { stringValue: 'subscription' },
      'ai.cost_estimated': { boolValue: true },
      'ai.subscription_covered': { boolValue: true },
      'ai.skills': { arrayValue: { values: [{ stringValue: 'anthropic-skills:docx' }] } },
      'ai.subagent_types': { arrayValue: { values: [{ stringValue: 'Explore' }] } },
    })
    // Deduplicated, and a path-shaped name never ships.
    expect(a['ai.mcp_tools']).toEqual({ arrayValue: { values: [{ stringValue: 'mcp__github__create_pr' }] } })
    // Summary still drops session context and the generic tool list.
    for (const gone of ['ai.call_count', 'ai.tools', 'ai.work_unit_id']) expect(a[gone]).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('rm -rf')
  })

  it('omits zero, false and default values', () => {
    const a = attrs({ call: call(), sessionId: 's', category: 'coding' }, 'summary')
    for (const key of DETAIL_LEVEL_ONLY_KEYS) {
      if (key === 'ai.category' || key === 'codeburn.detail_level') continue
      expect(a[key], key).toBeUndefined()
    }
  })

  it('sends a request weight only when it is not one', () => {
    expect(attrs({ call: call({ supplementaryAccounting: true }), sessionId: 's' }, 'summary')['ai.request_weight']).toEqual({ intValue: '0' })
    expect(attrs({ call: call({ requestCount: 12 }), sessionId: 's' }, 'summary')['ai.request_weight']).toEqual({ intValue: '12' })
  })

  it('names the billing route the model id implies', () => {
    expect(attrs({ call: call({ model: 'anthropic.claude-haiku-4-5-20251001-v1:0' }), sessionId: 's' }, 'summary')['ai.billing_route']).toEqual({ stringValue: 'bedrock' })
  })

  it('keeps the legacy wire free of every new key', () => {
    const a = attrs(rich())
    for (const key of DETAIL_LEVEL_ONLY_KEYS) expect(a[key], key).toBeUndefined()
    // The legacy heuristic, not the parser flag, decides cost_estimated there.
    expect(a['ai.cost_estimated']).toEqual({ boolValue: false })
  })

  it('discloses every core key in the consent text', () => {
    for (const key of CORE_SYNC_ATTRIBUTE_KEYS) expect(CORE_SYNC_FIELD_MEANINGS.has(key), key).toBe(true)
  })
})

describe('turn marking in collectUnsentCalls', () => {
  let tmpDir: string
  const originalHome = process.env.HOME
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-detail-'))
    setHome(tmpDir)
    process.env.XDG_CACHE_HOME = join(tmpDir, '.cache')
  })
  afterEach(async () => {
    setHome(originalHome)
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('marks the first behavioral call of each behavioral turn only', async () => {
    const turn = (key: string, calls: ParsedApiCall[], extra: Record<string, unknown> = {}) =>
      ({ assistantCalls: calls, timestamp: '2026-07-10T10:00:00.000Z', category: 'coding', hasEdits: true, retries: 1, ...extra })
    const projects = [{
      project: 'proj',
      sessions: [{
        sessionId: 'sess-1', project: 'proj', firstTimestamp: '2026-07-10T10:00:00.000Z', lastTimestamp: '2026-07-10T10:05:00.000Z',
        turns: [
          turn('a', [call({ deduplicationKey: 'a1', supplementaryAccounting: true }), call({ deduplicationKey: 'a2' }), call({ deduplicationKey: 'a3' })]),
          turn('b', [call({ deduplicationKey: 'b1' })], { projectContinuation: true }),
          turn('c', [call({ deduplicationKey: 'c1' })], { hasEdits: false, retries: 0 }),
        ],
      }],
    }] as unknown as ProjectSummary[]
    const { collectUnsentCalls } = await import('../src/sync/push.js')
    const marked = collectUnsentCalls(projects).allCalls.map(c => [c.call.deduplicationKey, c.turn ?? null])
    expect(marked).toEqual([
      ['a1', null],
      ['a2', { hasEdits: true, retries: 1 }],
      ['a3', null],
      ['b1', null],
      ['c1', { hasEdits: false, retries: 0 }],
    ])
  })
})
