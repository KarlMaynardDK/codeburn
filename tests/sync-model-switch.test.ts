/**
 * ai.model_switch_tokens: the first call after a mid-session model switch that
 * re-sent the conversation while the old cache was warm carries the context
 * tokens it re-sent. Detail-level wires only; subagent transcripts never.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildOtlpPayload, type CallWithSession } from '../src/sync/otlp.js'
import type { ParsedApiCall, ProjectSummary } from '../src/types.js'
import { setHome } from './setup/home.js'

function call(key: string, model: string, minute: number, usage: { input?: number; read?: number; write?: number }): ParsedApiCall {
  return {
    provider: 'claude',
    model,
    usage: {
      inputTokens: usage.input ?? 0, outputTokens: 50, cacheCreationInputTokens: usage.write ?? 0,
      cacheReadInputTokens: usage.read ?? 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0,
    },
    costUSD: 0.01,
    tools: [],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: new Date(Date.parse('2026-07-10T10:00:00.000Z') + minute * 60_000).toISOString(),
    bashCommands: [],
    deduplicationKey: key,
  }
}

function project(calls: ParsedApiCall[], extra: Record<string, unknown> = {}): ProjectSummary {
  const sum = (f: (c: ParsedApiCall) => number) => calls.reduce((n, c) => n + f(c), 0)
  return {
    project: 'proj',
    projectPath: '/tmp/proj',
    totalCostUSD: 1,
    totalApiCalls: calls.length,
    sessions: [{
      sessionId: 'sess-1', project: 'proj', firstTimestamp: calls[0]!.timestamp, lastTimestamp: calls.at(-1)!.timestamp,
      totalCacheReadTokens: sum(c => c.usage.cacheReadInputTokens), totalCacheWriteTokens: sum(c => c.usage.cacheCreationInputTokens),
      turns: calls.map(c => ({ assistantCalls: [c], timestamp: c.timestamp, category: 'coding', hasEdits: false, retries: 0, userMessage: '', sessionId: 'sess-1' })),
      ...extra,
    }],
  } as unknown as ProjectSummary
}

const SWITCHED = () => [
  call('a', 'claude-sonnet-4-5', 0, { input: 100, write: 60_000 }),
  call('b', 'claude-sonnet-4-5', 1, { input: 100, read: 60_000, write: 20_000 }),
  call('c', 'claude-opus-4-1', 2, { input: 100, write: 80_000 }),
]

describe('model switches in collectUnsentCalls', () => {
  let tmpDir: string
  const originalHome = process.env.HOME
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-switch-'))
    setHome(tmpDir)
    process.env.XDG_CACHE_HOME = join(tmpDir, '.cache')
  })
  afterEach(async () => {
    setHome(originalHome)
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('marks only the call that re-sent the context, with the tokens it re-sent', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')
    const marked = collectUnsentCalls([project(SWITCHED())]).allCalls.map(c => [c.call.deduplicationKey, c.modelSwitchTokens ?? null])
    expect(marked).toEqual([['a', null], ['b', null], ['c', 80_100]])
  })

  it('never marks a subagent transcript', async () => {
    const { collectUnsentCalls } = await import('../src/sync/push.js')
    const all = collectUnsentCalls([project(SWITCHED(), { isSidechain: true })]).allCalls
    expect(all.every(c => c.modelSwitchTokens === undefined)).toBe(true)
  })
})

describe('ai.model_switch_tokens on the wire', () => {
  const item = (): CallWithSession => ({ call: SWITCHED()[2]!, sessionId: 's', category: 'coding', modelSwitchTokens: 80_100 })
  const attr = (detailLevel?: 'summary' | 'sessions') => buildOtlpPayload([item()], detailLevel ? { detailLevel } : undefined)
    .resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.find(a => a.key === 'ai.model_switch_tokens')?.value

  it('is sent at summary and sessions', () => {
    expect(attr('summary')).toEqual({ intValue: '80100' })
    expect(attr('sessions')).toEqual({ intValue: '80100' })
  })

  it('stays off the legacy wire', () => {
    expect(attr()).toBeUndefined()
  })
})
