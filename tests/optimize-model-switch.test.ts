import { describe, it, expect } from 'vitest'

import {
  detectModelSwitchRecache,
  findModelSwitchEvents,
  findingClass,
  findingPricing,
  findingUSD,
} from '../src/optimize.js'
import type { ParsedApiCall, ProjectSummary } from '../src/types.js'

type TestSession = ProjectSummary['sessions'][number]
type TestTurn = TestSession['turns'][number]

const T0 = Date.parse('2026-05-01T10:00:00Z')

function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString()
}

/// One call. `read` and `write` are the cache split, `input` the uncached rest.
function call(model: string, minutes: number, usage: { input?: number; read?: number; write?: number }, extra: Partial<ParsedApiCall> = {}): ParsedApiCall {
  return {
    provider: 'claude',
    model,
    usage: {
      inputTokens: usage.input ?? 0,
      outputTokens: 500,
      cacheCreationInputTokens: usage.write ?? 0,
      cacheReadInputTokens: usage.read ?? 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0.01,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: at(minutes),
    bashCommands: [],
    deduplicationKey: `${model}-${minutes}`,
    ...extra,
  }
}

function session(calls: ParsedApiCall[], overrides: Partial<TestSession> = {}): TestSession {
  const turns: TestTurn[] = calls.map(c => ({
    userMessage: 'go',
    assistantCalls: [c],
    timestamp: c.timestamp,
    sessionId: 's1',
    category: 'coding',
    retries: 0,
    hasEdits: false,
  }))
  const sum = (f: (c: ParsedApiCall) => number) => calls.reduce((n, c) => n + f(c), 0)
  return {
    sessionId: 's1',
    project: 'app',
    firstTimestamp: calls[0]?.timestamp ?? at(0),
    lastTimestamp: calls.at(-1)?.timestamp ?? at(0),
    totalCostUSD: 1,
    totalInputTokens: sum(c => c.usage.inputTokens),
    totalOutputTokens: sum(c => c.usage.outputTokens),
    totalReasoningTokens: 0,
    totalCacheReadTokens: sum(c => c.usage.cacheReadInputTokens),
    totalCacheWriteTokens: sum(c => c.usage.cacheCreationInputTokens),
    apiCalls: calls.length,
    turns,
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as TestSession['categoryBreakdown'],
    skillBreakdown: {},
    ...overrides,
  }
}

function project(...sessions: TestSession[]): ProjectSummary {
  return {
    project: 'app',
    projectPath: '/tmp/app',
    sessions,
    totalCostUSD: sessions.reduce((n, s) => n + s.totalCostUSD, 0),
    totalApiCalls: sessions.reduce((n, s) => n + s.apiCalls, 0),
  }
}

const SONNET = 'claude-sonnet-4-5'
const OPUS = 'claude-opus-4-1'

/// A warm sonnet session, then a switch to opus that re-writes 80K of context.
function switchedSession(gapMinutes = 1, afterSwitch: { input?: number; read?: number; write?: number } = { input: 100, write: 80_000 }): TestSession {
  return session([
    call(SONNET, 0, { input: 100, write: 60_000 }),
    call(SONNET, 1, { input: 100, read: 60_000, write: 20_000 }),
    call(OPUS, 1 + gapMinutes, afterSwitch),
  ])
}

describe('findModelSwitchEvents', () => {
  it('records a switch that re-sent warm context to the new model', () => {
    const events = findModelSwitchEvents([project(switchedSession())])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: 's1', from: SONNET, to: OPUS })
    // Capped at the previous call's prompt (100 + 60K + 20K).
    expect(events[0]!.carriedTokens).toBe(80_100)
  })

  it('ignores a switch after the cache had already expired', () => {
    expect(findModelSwitchEvents([project(switchedSession(10))])).toHaveLength(0)
  })

  it('uses the one-hour window once the session writes one-hour cache', () => {
    const s = session([
      call(SONNET, 0, { input: 100, write: 60_000 }, { cacheCreationOneHourTokens: 60_000 }),
      call(OPUS, 30, { input: 100, write: 60_000 }),
    ])
    expect(findModelSwitchEvents([project(s)])).toHaveLength(1)
  })

  it('ignores a switch back to a model whose cache was still warm', () => {
    const s = session([
      call(SONNET, 0, { input: 100, write: 60_000 }),
      call(OPUS, 1, { input: 100, write: 60_000 }),
      call(SONNET, 2, { input: 100, read: 60_000 }),
    ])
    const events = findModelSwitchEvents([project(s)])
    expect(events.map(e => e.to)).toEqual([OPUS])
  })

  it('ignores small contexts', () => {
    const s = session([
      call(SONNET, 0, { input: 100, write: 10_000 }),
      call(OPUS, 1, { input: 100, write: 10_000 }),
    ])
    expect(findModelSwitchEvents([project(s)])).toHaveLength(0)
  })

  it('does not treat a date-stamped id of the same model as a switch', () => {
    const s = session([
      call('claude-sonnet-4-5', 0, { input: 100, write: 60_000 }),
      call('claude-sonnet-4-5-20250929', 1, { input: 100, write: 60_000 }),
    ])
    expect(findModelSwitchEvents([project(s)])).toHaveLength(0)
  })

  it('skips synthetic and accounting-only calls', () => {
    const s = session([
      call(SONNET, 0, { input: 100, write: 60_000 }),
      call('<synthetic>', 1, {}),
      call(OPUS, 1, { input: 100, write: 60_000 }, { supplementaryAccounting: true }),
      call(SONNET, 2, { input: 100, read: 60_000 }),
    ])
    expect(findModelSwitchEvents([project(s)])).toHaveLength(0)
  })

  it('skips subagent transcripts', () => {
    expect(findModelSwitchEvents([project({ ...switchedSession(), isSidechain: true })])).toHaveLength(0)
  })

  it('skips sessions that never report cache tokens', () => {
    const s = session([
      call(SONNET, 0, { input: 60_000 }),
      call(OPUS, 1, { input: 60_000 }),
    ])
    expect(findModelSwitchEvents([project(s)])).toHaveLength(0)
  })

  it('does not count new turn content beyond the carried context', () => {
    const s = session([
      call(SONNET, 0, { input: 100, write: 30_000 }),
      call(OPUS, 1, { input: 100, write: 90_000 }),
    ])
    expect(findModelSwitchEvents([project(s)])[0]!.carriedTokens).toBe(30_100)
  })
})

describe('detectModelSwitchRecache', () => {
  it('returns null without switches', () => {
    const s = session([
      call(SONNET, 0, { input: 100, write: 60_000 }),
      call(SONNET, 1, { input: 100, read: 60_000 }),
    ])
    expect(detectModelSwitchRecache([project(s)])).toBeNull()
  })

  it('names the session, the switch and the re-sent tokens', () => {
    const projects = [project(switchedSession())]
    const finding = detectModelSwitchRecache(projects, findingPricing(projects, 0.000003))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('model-switch-recache')
    expect(finding!.title).toBe('1 mid-session model switch re-sent the context')
    expect(finding!.explanation).toContain('app/s1: 1 switch (')
    expect(finding!.explanation).toContain('80.1K re-sent')
    expect(finding!.impact).toBe('low')
    expect(finding!.tokensSaved).toBe(Math.round(80_100 * 0.9))
    expect(findingClass(finding!)).toBe('nudge')
    // Priced at the new model's own rates, so it outranks the blended rate.
    expect(finding!.savingsUSD).toBeGreaterThan(0)
    expect(findingUSD(finding!, 0)).toBe(finding!.savingsUSD)
  })

  it('falls back to the blended rate when a model has no price', () => {
    const s = session([
      call(SONNET, 0, { input: 100, write: 60_000 }),
      call('mystery-model-xyz', 1, { input: 100, write: 60_000 }),
    ])
    const projects = [project(s)]
    const finding = detectModelSwitchRecache(projects, findingPricing(projects, 0.000003))
    expect(finding).not.toBeNull()
    expect(finding!.savingsUSD).toBeUndefined()
  })
})
