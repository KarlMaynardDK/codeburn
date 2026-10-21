import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'

import {
  buildAttributionOtlpPayload,
  buildOtlpPayload,
  getDeviceId,
  flattenAttributionRecords,
  projectBasenameFromWorkingDirectory,
  type CallWithSession,
} from '../src/sync/otlp.js'
import type { ParsedApiCall } from '../src/types.js'
import type { SessionAttributionRecord } from '../src/yield.js'

function call(overrides: Partial<ParsedApiCall> = {}): ParsedApiCall {
  return {
    provider: 'codex',
    model: 'gpt-5.5',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: 0.01,
    tools: ['Edit'],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-08-24T10:00:00.000Z',
    bashCommands: [],
    deduplicationKey: 'privacy-call-1',
    ...overrides,
  }
}

function usage(workingDirectory?: string, overrides: Partial<ParsedApiCall> = {}): CallWithSession {
  return {
    call: call(overrides),
    sessionId: 'privacy-session-1',
    workingDirectory,
  }
}

function attributes(item: CallWithSession): Record<string, unknown> {
  const span = buildOtlpPayload([item]).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
  return Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value]))
}

describe('sync project privacy boundary', () => {
  it.each([
    ['/Users/alice/work/private-widget', 'private-widget'],
    ['C:\\Users\\alice\\work\\private-widget', 'private-widget'],
  ])('emits only the basename of a trusted absolute cwd %s', (cwd, expected) => {
    expect(projectBasenameFromWorkingDirectory(cwd)).toBe(expected)
    expect(attributes(usage(cwd))['ai.project']).toEqual({ stringValue: expected })
    expect(JSON.stringify(buildOtlpPayload([usage(cwd)]))).not.toContain(cwd)
  })

  it.each([
    undefined,
    '',
    '.',
    '/',
    'C:\\',
    '-Users-alice-secret-repo',
    'LLM-authored project title',
    '%2FUsers%2Falice%2Fsecret',
    '/Users/alice',
    '/home/alice',
    '/root',
    '/mnt/c/Users/alice',
    '/var/home/alice',
    '/net/home/alice',
    '/sessions/synthetic-customer-secret',
    '\\\\server\\Users\\alice',
    'D:\\Profiles\\alice',
  ])('omits ai.project when cwd provenance is absent or unsafe: %s', cwd => {
    expect(projectBasenameFromWorkingDirectory(cwd)).toBeUndefined()
    expect(attributes(usage(cwd))['ai.project']).toBeUndefined()
  })

  it.each([
    'alice@example.com',
    'api_key=synthetic-secret',
    'github_pat_abcdefghijklmnopqrstuvwxyz1234567890',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'encoded%2Fseparator',
    'encoded%5Cseparator',
  ])('omits credential-, email-, and encoded-path-shaped basenames: %s', basename => {
    expect(attributes(usage(`/workspace/${basename}`))['ai.project']).toBeUndefined()
  })
})

describe('sync identifier privacy boundary', () => {
  it('redacts unsafe provider/model strings, drops unsafe tools, and keeps useful identifiers', () => {
    const payload = buildOtlpPayload([usage('/workspace/widget', {
      provider: '/Users/alice/.config/private-provider',
      model: 'api_key=synthetic-secret',
      tools: ['Edit', '/Users/alice/.ssh/id_rsa', 'mcp__github__search', 'alice@example.com'],
    })])
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    const attrs = Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value]))

    expect(attrs['ai.provider']).toEqual({ stringValue: 'unknown' })
    expect(attrs['ai.model']).toEqual({ stringValue: 'unknown' })
    expect(attrs['ai.tools']).toEqual({
      arrayValue: { values: [{ stringValue: 'Edit' }, { stringValue: 'mcp__github__search' }] },
    })
    expect(span.name).toBe('unknown/unknown')
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('/Users/alice')
    expect(wire).not.toContain('synthetic-secret')
    expect(wire).not.toContain('alice@example.com')
  })

  it('preserves real routed provider, model, and tool identifiers', () => {
    const payload = buildOtlpPayload([usage('/workspace/widget', {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      tools: ['orcarouter/openai-compatible', 'mcp__github__search'],
    })])
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    const attrs = Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value]))

    expect(attrs['ai.provider']).toEqual({ stringValue: 'openrouter' })
    expect(attrs['ai.model']).toEqual({ stringValue: 'anthropic/claude-sonnet-4.6' })
    expect(attrs['ai.tools']).toEqual({
      arrayValue: { values: [
        { stringValue: 'orcarouter/openai-compatible' },
        { stringValue: 'mcp__github__search' },
      ] },
    })
    expect(span.name).toBe('openrouter/anthropic/claude-sonnet-4.6')
  })
})

describe('sync attribution project privacy boundary', () => {
  function record(overrides: Partial<SessionAttributionRecord> = {}): SessionAttributionRecord {
    return {
      sessionId: 'privacy-session-1',
      project: 'LLM-authored /Users/alice/secret',
      repo: 'github.com/acme/widget',
      prLinks: [],
      commits: [],
      firstTimestamp: '2026-08-24T10:00:00.000Z',
      lastTimestamp: '2026-08-24T10:01:00.000Z',
      ...overrides,
    }
  }

  it('derives ai.project from normalized git.repo, never the parser project label', () => {
    const payload = buildAttributionOtlpPayload(flattenAttributionRecords([record()]))
    const attrs = Object.fromEntries(payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
      .map(attribute => [attribute.key, attribute.value]))
    expect(attrs['ai.project']).toEqual({ stringValue: 'widget' })
    expect(JSON.stringify(payload)).not.toContain('/Users/alice/secret')
  })

  it('omits ai.project for PR-only attribution without a normalized repo', () => {
    const payload = buildAttributionOtlpPayload(flattenAttributionRecords([record({
      repo: null,
      prLinks: ['https://github.com/acme/widget/pull/1'],
    })]))
    const attrs = Object.fromEntries(payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
      .map(attribute => [attribute.key, attribute.value]))
    expect(attrs['ai.project']).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain('/Users/alice/secret')
  })

  it('accepts owner/repo identities and rejects credential-directory repo labels', () => {
    const [legitimate, credentialShaped] = flattenAttributionRecords([
      record({ repo: 'acme/widget' }),
      record({ sessionId: 'privacy-session-2', repo: 'acme/.ssh' }),
    ])

    expect(legitimate?.project).toBe('widget')
    expect(credentialShaped?.project).toBeUndefined()
    const payload = buildAttributionOtlpPayload([legitimate!, credentialShaped!])
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans
    const credentialAttributes = Object.fromEntries(spans[1]!.attributes
      .map(attribute => [attribute.key, attribute.value]))
    expect(credentialAttributes['ai.project']).toBeUndefined()
  })
})


describe('summary detail level wire shape', () => {
  const withSession = (): CallWithSession => ({
    call: call({ timestamp: '2026-08-24T10:47:31.123Z' }),
    sessionId: 'privacy-session-1',
    workingDirectory: '/Users/alice/work/widget',
    category: 'debugging',
    session: { callCount: 7, durationMs: 4000, workUnitId: 'wu1', sessionRole: 'root' },
  })
  const spanOf = (level: 'summary' | 'sessions') =>
    buildOtlpPayload([withSession()], { detailLevel: level }).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
  const keys = (span: { attributes: Array<{ key: string }> }) => span.attributes.map(a => a.key)

  it('omits session attributes and tools at summary, keeps core + category + project', () => {
    const k = keys(spanOf('summary'))
    for (const gone of ['ai.work_unit_id', 'ai.session_role', 'ai.lineage_evidence', 'ai.session_duration_ms', 'ai.call_count', 'ai.tools']) {
      expect(k).not.toContain(gone)
    }
    for (const kept of ['ai.provider', 'ai.model', 'ai.input_tokens', 'ai.output_tokens', 'ai.cost_usd', 'ai.project', 'ai.category']) {
      expect(k).toContain(kept)
    }
  })

  it('sessions level keeps the full span set and adds ai.category', () => {
    const k = keys(spanOf('sessions'))
    for (const present of ['ai.work_unit_id', 'ai.session_role', 'ai.call_count', 'ai.session_duration_ms', 'ai.tools', 'ai.category']) {
      expect(k).toContain(present)
    }
    expect(spanOf('sessions').traceId).toBe(createHash('sha256').update('privacy-session-1').digest('hex').slice(0, 32))
  })

  it('stamps codeburn.detail_level as a resource attribute', () => {
    for (const level of ['summary', 'sessions'] as const) {
      const attrs = buildOtlpPayload([withSession()], { detailLevel: level }).resourceSpans[0]!.resource.attributes
      expect(attrs).toContainEqual({ key: 'codeburn.detail_level', value: { stringValue: level } })
    }
  })

  it('uses a per-device per-day traceId, identical across sessions of the same day', () => {
    const a = buildOtlpPayload([withSession()], { detailLevel: 'summary' }).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    const other = { ...withSession(), sessionId: 'another-session', call: call({ timestamp: '2026-08-24T23:59:00.000Z', deduplicationKey: 'k2' }) }
    const b = buildOtlpPayload([other], { detailLevel: 'summary' }).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    const expected = createHash('sha256').update(`${getDeviceId()}:2026-08-24`).digest('hex').slice(0, 32)
    expect(a.traceId).toBe(expected)
    expect(b.traceId).toBe(expected)
    const nextDay = { ...withSession(), call: call({ timestamp: '2026-08-25T00:01:00.000Z', deduplicationKey: 'k3' }) }
    const c = buildOtlpPayload([nextDay], { detailLevel: 'summary' }).resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    expect(c.traceId).not.toBe(expected)
  })

  it('rounds start/end down to the hour at summary only; spanId unchanged', () => {
    const s = spanOf('summary')
    const full = spanOf('sessions')
    const hour = BigInt(Date.parse('2026-08-24T10:00:00.000Z')) * 1_000_000n
    expect(s.startTimeUnixNano).toBe(hour.toString())
    expect(s.endTimeUnixNano).toBe(hour.toString())
    expect(full.startTimeUnixNano).toBe((BigInt(Date.parse('2026-08-24T10:47:31.123Z')) * 1_000_000n).toString())
    expect(s.spanId).toBe(full.spanId)
  })

  it('never serializes cwd or session id at summary', () => {
    const wire = JSON.stringify(buildOtlpPayload([withSession()], { detailLevel: 'summary' }))
    expect(wire).not.toContain('/Users/alice')
    expect(wire).not.toContain('privacy-session-1')
  })
})
