/**
 * Upgrade regression: an OIDC sync config written before team servers existed
 * (no authMode, no detail level, an auto-sync acceptance hashed the old way)
 * keeps auto-syncing without a new acceptance, and its receiver sees the same
 * wire as before: no codeburn.detail_level, no ai.category.
 * See docs/preserving-existing-oidc-sync.md.
 */

import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { Command } from 'commander'

import type { ProjectSummary, ParsedApiCall, SessionSummary } from '../src/types.js'
import { setHome } from './setup/home.js'

const { parseAllSessionsMock } = vi.hoisted(() => ({ parseAllSessionsMock: vi.fn() }))
vi.mock('../src/parser.js', () => ({ parseAllSessions: parseAllSessionsMock }))
vi.mock('../src/sync/auth.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/sync/auth.js')>()),
  fetchOidcConfig: vi.fn(async () => ({ token_endpoint: 'https://idp.example.com/token' })),
  refreshToken: vi.fn(async () => ({ access_token: 'oidc-access' })),
}))

/** CORE_SYNC_ATTRIBUTE_KEYS as shipped before team servers (main at 1a3ce74a). */
const PRE_TEAM_SERVER_KEYS = [
  'ai.provider', 'ai.model', 'ai.input_tokens', 'ai.output_tokens', 'ai.cost_usd', 'ai.speed',
  'ai.project', 'ai.tools', 'ai.cost_estimated', 'ai.work_unit_id', 'ai.session_role',
  'ai.lineage_evidence', 'ai.cache_read_tokens', 'ai.cache_write_tokens', 'ai.call_count',
  'ai.session_duration_ms', 'ai.subscription_covered', 'codeburn.device_id',
  'codeburn.coverage_through', 'codeburn.attribution_methodology',
  'git.repo', 'git.sha', 'git.commit_count', 'git.in_main', 'git.was_reverted', 'git.pr_links',
].sort()

interface Fake {
  server: Server
  baseUrl: string
  traces: Array<{ auth: string | undefined; body: any }>
}

let fake: Fake
let tmpHome: string
let stderr: string[]
const originalHome = process.env.HOME
const originalStore = process.env.CODEBURN_SYNC_TOKEN_STORE

/** An OIDC endpoint that predates detail levels: no detail_levels, no findings_path. */
async function startFake(): Promise<Fake> {
  const f = { traces: [] } as unknown as Fake
  f.server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/.well-known/codeburn-export.json') {
        return json(200, { version: 1, issuer: 'https://idp.example.com', client_id: 'acme', traces_path: '/v1/traces', max_batch_size: 1000 })
      }
      if (req.url === '/v1/traces' && req.method === 'POST') {
        f.traces.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) })
        return json(200, { partialSuccess: {} })
      }
      json(404, {})
    })
  })
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r))
  f.baseUrl = `http://127.0.0.1:${(f.server.address() as { port: number }).port}`
  return f
}

function makeCall(key: string, ts: string): ParsedApiCall {
  return {
    provider: 'test', model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
    costUSD: 0.01, tools: ['Edit'], mcpTools: [], skills: [], subagentTypes: [], hasAgentSpawn: false,
    hasPlanMode: false, speed: 'standard', timestamp: ts, bashCommands: [], deduplicationKey: key,
  }
}

function project(): ProjectSummary {
  const first = new Date(Date.now() - 3600_000).toISOString()
  const session = {
    sessionId: 'oidc-sess', project: 'app', firstTimestamp: first, lastTimestamp: first,
    totalCostUSD: 0.01, totalSavingsUSD: 0, totalInputTokens: 10, totalOutputTokens: 5,
    totalReasoningTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, apiCalls: 1,
    turns: [{ userMessage: 'prompt', assistantCalls: [makeCall(`oidc-${Date.now()}`, first)], timestamp: first, sessionId: 'oidc-sess', category: 'testing', retries: 0, hasEdits: false }],
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {}, skillBreakdown: {}, subagentBreakdown: {},
    workingDirectory: '/home/alice/work/widget',
  } as unknown as SessionSummary
  return { project: 'app', projectPath: '/home/alice/work/widget', sessions: [session] } as ProjectSummary
}

async function run(...args: string[]): Promise<void> {
  const { registerSyncCommands } = await import('../src/sync/cli.js')
  const program = new Command()
  program.exitOverride()
  registerSyncCommands(program)
  await program.parseAsync(['node', 'codeburn', 'sync', ...args])
}

/** sync.json exactly as `sync setup` + `sync auto enable --accept` wrote it before team servers. */
async function writePreTeamServerConfig(): Promise<string> {
  const input = {
    org: 'acme', destination: fake.baseUrl, outboundFields: PRE_TEAM_SERVER_KEYS,
    workMatching: false, scopeSinceDays: 7, cadence: 'daily' as const,
  }
  // The fingerprint as the old computeAcceptanceFingerprint hashed it, built here
  // independently so a change to the current hashing cannot hide a mismatch.
  const fingerprint = createHash('sha256').update(JSON.stringify({
    org: input.org, destination: input.destination, contractVersion: 'v2',
    outboundFields: input.outboundFields, workMatching: false, scopeSinceDays: 7, cadence: 'daily',
  })).digest('hex')
  const { writeSyncConfig } = await import('../src/sync/config.js')
  writeSyncConfig({
    baseUrl: fake.baseUrl, clientId: 'acme', tracesPath: '/v1/traces', issuer: 'https://idp.example.com',
    auto: { accepted: { fingerprint, acceptedAt: '2026-09-01T00:00:00.000Z', cadence: 'daily', disclosure: '(old disclosure)', attribution: false, input } },
  })
  const { createCredentialStore } = await import('../src/sync/credentials.js')
  createCredentialStore().store('oidc-refresh')
  return fingerprint
}

function spanKeys(): Set<string> {
  return new Set(fake.traces.flatMap(t => t.body.resourceSpans.flatMap((rs: any) =>
    rs.scopeSpans.flatMap((ss: any) => ss.spans.flatMap((s: any) => s.attributes.map((a: any) => a.key))))))
}

function resourceKeys(): Set<string> {
  return new Set(fake.traces.flatMap(t => t.body.resourceSpans.flatMap((rs: any) => rs.resource.attributes.map((a: any) => a.key))))
}

beforeAll(async () => {
  fake = await startFake()
  process.env.CODEBURN_SYNC_TOKEN_STORE = 'file'
})
afterAll(async () => {
  await new Promise<void>(r => fake.server.close(() => r()))
  if (originalStore === undefined) delete process.env.CODEBURN_SYNC_TOKEN_STORE
  else process.env.CODEBURN_SYNC_TOKEN_STORE = originalStore
})
beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'codeburn-oidc-upgrade-'))
  setHome(tmpHome)
  process.env.XDG_CACHE_HOME = join(tmpHome, '.cache')
  fake.traces.length = 0
  stderr = []
  parseAllSessionsMock.mockResolvedValue([project()])
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true }) as never)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = 0
  setHome(originalHome)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('OIDC config from before team servers', () => {
  it('auto run keeps pushing under the old acceptance', async () => {
    const fingerprint = await writePreTeamServerConfig()
    await run('auto', 'run')

    const { readReceipts, readSyncConfig } = await import('../src/sync/config.js')
    const receipts = readReceipts()
    expect(receipts.at(-1)).toMatchObject({ result: 'pushed', fingerprint })
    expect((receipts.at(-1) as { spans: number }).spans).toBeGreaterThan(0)
    expect(readSyncConfig()!.auto!.accepted!.fingerprint).toBe(fingerprint)
    expect(fake.traces.every(t => t.auth === 'Bearer oidc-access')).toBe(true)
  })

  it('auto run sends the pre-team-server wire: full span set, no detail_level, no ai.category', async () => {
    await writePreTeamServerConfig()
    await run('auto', 'run')

    expect(fake.traces.length).toBeGreaterThan(0)
    const keys = spanKeys()
    expect(keys).not.toContain('ai.category')
    for (const key of ['ai.tools', 'ai.call_count', 'ai.session_duration_ms']) expect(keys).toContain(key)
    for (const key of keys) expect(PRE_TEAM_SERVER_KEYS).toContain(key)
    expect(resourceKeys()).not.toContain('codeburn.detail_level')
    expect(fake.traces[0]!.body.resourceSpans[0].scopeSpans[0].spans[0].traceId)
      .toBe(createHash('sha256').update('oidc-sess').digest('hex').slice(0, 32))
  })

  it('manual push sends the same wire and reports no paused auto sync', async () => {
    await writePreTeamServerConfig()
    await run('push')

    expect(fake.traces.length).toBeGreaterThan(0)
    expect(spanKeys()).not.toContain('ai.category')
    expect(resourceKeys()).not.toContain('codeburn.detail_level')
    expect(stderr.join('')).not.toContain('Automatic sync is paused')
  })

  it('an explicit detail level stamps the new attributes and visibly pauses auto sync', async () => {
    await writePreTeamServerConfig()
    await run('config', 'detail', 'sessions')

    await run('auto', 'run')
    const { readReceipts } = await import('../src/sync/config.js')
    const last = readReceipts().at(-1) as { result: string; changed: string[] }
    expect(last.result).toBe('acceptance-required')
    expect(last.changed).toContain('detail level')
    const fieldChange = last.changed.find(c => c.startsWith('field set (added: '))
    for (const key of ['ai.category', 'codeburn.detail_level', 'ai.turn_start', 'ai.mcp_tools']) expect(fieldChange).toContain(key)
    expect(fieldChange).not.toContain('removed:')
    expect(fake.traces).toHaveLength(0)

    await run('push')
    expect(spanKeys()).toContain('ai.category')
    expect(fake.traces[0]!.body.resourceSpans[0].resource.attributes)
      .toContainEqual({ key: 'codeburn.detail_level', value: { stringValue: 'sessions' } })
    expect(stderr.join('')).toContain('Automatic sync is paused')
    expect(stderr.join('')).toContain('codeburn sync auto enable --accept')
  })
})

describe('buildOtlpPayload without a detail level', () => {
  it('drops ai.category and stamps no detail level', async () => {
    const { buildOtlpPayload } = await import('../src/sync/otlp.js')
    const payload = buildOtlpPayload([{ call: makeCall('k1', '2026-08-24T10:47:31.123Z'), sessionId: 's1', category: 'debugging' }])
    const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
    expect(span.attributes.map(a => a.key)).not.toContain('ai.category')
    expect(payload.resourceSpans[0]!.resource.attributes.map(a => a.key)).not.toContain('codeburn.detail_level')
  })
})
