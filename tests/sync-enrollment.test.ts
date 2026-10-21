/**
 * Enrollment auth end to end: `sync setup --token` against a fake loopback
 * team server stores the device credential; `sync push` sends it as Bearer
 * with the summary wire shape; a 401 tells the user to re-enroll.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { Command } from 'commander'

import type { ProjectSummary, ParsedApiCall, SessionSummary } from '../src/types.js'
import { setHome } from './setup/home.js'

const { parseAllSessionsMock } = vi.hoisted(() => ({ parseAllSessionsMock: vi.fn() }))
vi.mock('../src/parser.js', () => ({ parseAllSessions: parseAllSessionsMock }))

interface Fake {
  server: Server
  baseUrl: string
  enrollBodies: unknown[]
  traces: Array<{ auth: string | undefined; body: any }>
  findings: Array<{ auth: string | undefined; body: any }>
  rejectTraces: boolean
}

let fake: Fake
let tmpHome: string
const originalHome = process.env.HOME
const originalStore = process.env.CODEBURN_SYNC_TOKEN_STORE

async function startFake(): Promise<Fake> {
  const f = { enrollBodies: [], traces: [], findings: [], rejectTraces: false } as unknown as Fake
  f.server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/.well-known/codeburn-export.json') {
        return json(200, {
          version: 1, auth: 'enrollment', enroll_path: '/v1/enroll', traces_path: '/v1/traces',
          max_batch_size: 1000, detail_levels: ['summary'], findings_path: '/v1/findings', org_name: 'Acme',
        })
      }
      if (req.url === '/v1/enroll' && req.method === 'POST') {
        const body = JSON.parse(text)
        f.enrollBodies.push(body)
        if (body.token !== 'cbe_good') return json(401, { error: 'invalid_or_expired_token' })
        return json(200, { credential: 'cbd_secret', device_id: 'dev1', person: { name: 'Karl', email: 'k@x.dk' } })
      }
      if (req.url === '/v1/traces' && req.method === 'POST') {
        f.traces.push({ auth: req.headers.authorization, body: JSON.parse(text) })
        if (f.rejectTraces) return json(401, { error: 'unauthenticated' })
        return json(200, { partialSuccess: {} })
      }
      if (req.url === '/v1/findings' && req.method === 'POST') {
        f.findings.push({ auth: req.headers.authorization, body: JSON.parse(text) })
        return json(200, { ok: true })
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
    sessionId: 'enr-sess', project: 'app', firstTimestamp: first, lastTimestamp: first,
    totalCostUSD: 0.01, totalSavingsUSD: 0, totalInputTokens: 10, totalOutputTokens: 5,
    totalReasoningTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, apiCalls: 1,
    turns: [{ userMessage: 'SECRET PROMPT', assistantCalls: [makeCall(`enr-${Date.now()}`, first)], timestamp: first, sessionId: 'enr-sess', category: 'testing', retries: 0, hasEdits: false }],
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
  tmpHome = await mkdtemp(join(tmpdir(), 'codeburn-enroll-'))
  setHome(tmpHome)
  process.env.XDG_CACHE_HOME = join(tmpHome, '.cache')
  fake.enrollBodies.length = 0
  fake.traces.length = 0
  fake.findings.length = 0
  fake.rejectTraces = false
  parseAllSessionsMock.mockResolvedValue([project()])
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = 0
  setHome(originalHome)
  await rm(tmpHome, { recursive: true, force: true })
})

describe('sync setup --token (enrollment)', () => {
  it('enrolls, stores the credential, and persists discovery + client settings', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good')
    expect(fake.enrollBodies).toHaveLength(1)
    expect((fake.enrollBodies[0] as any).token).toBe('cbe_good')

    const { createCredentialStore } = await import('../src/sync/credentials.js')
    expect(createCredentialStore().retrieve()).toBe('cbd_secret')

    const { readSyncConfig } = await import('../src/sync/config.js')
    const cfg = readSyncConfig()!
    expect(cfg.authMode).toBe('enrollment')
    expect(cfg.enrollPath).toBe('/v1/enroll')
    expect(cfg.detailLevels).toEqual(['summary'])
    expect(cfg.findingsPath).toBe('/v1/findings')
    expect(cfg.orgName).toBe('Acme')
  })

  it('exits with an error for a bad token and stores nothing', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)
    await expect(run('setup', fake.baseUrl, '--token', 'cbe_bad')).rejects.toThrow('exit')
    expect(exit).toHaveBeenCalledWith(1)
    const { createCredentialStore } = await import('../src/sync/credentials.js')
    expect(createCredentialStore().retrieve()).toBeNull()
  })
})

describe('sync push with enrollment auth', () => {
  it('sends the stored credential as Bearer, clamped to summary, without session detail', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--detail', 'sessions')
    await run('push')
    expect(fake.traces.length).toBeGreaterThan(0)
    expect(fake.traces.every(t => t.auth === 'Bearer cbd_secret')).toBe(true)

    const wire = JSON.stringify(fake.traces.map(t => t.body))
    const resource = fake.traces[0]!.body.resourceSpans[0].resource.attributes
    expect(resource).toContainEqual({ key: 'codeburn.detail_level', value: { stringValue: 'summary' } })
    expect(wire).toContain('ai.category')
    expect(wire).not.toContain('ai.call_count')
    expect(wire).not.toContain('ai.tools')
    expect(wire).not.toContain('SECRET PROMPT')
    expect(wire).not.toContain('/home/alice')
  })

  it('a 401 tells the user to re-enroll', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good')
    fake.rejectTraces = true
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit') }) as never)
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((m: string) => { written.push(String(m)); return true }) as never)
    await expect(run('push')).rejects.toThrow()
    expect(written.join('')).toContain(`codeburn sync setup ${fake.baseUrl} --token <new token>`)
  })

  it('uploads findings at most once per day when enabled', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--share-findings')
    const findings = await import('../src/sync/findings.js')
    const { readSyncConfig } = await import('../src/sync/config.js')
    const build = async () => ({ summary: { findingCount: 0 } })
    expect(await findings.maybeSendFindings({ config: readSyncConfig()!, findingsPath: '/v1/findings', bearer: 'cbd_secret', buildReport: build })).toBe('sent')
    expect(fake.findings).toHaveLength(1)
    expect(fake.findings[0]!.auth).toBe('Bearer cbd_secret')
    expect(fake.findings[0]!.body.findings.summary.findingCount).toBe(0)
    expect(typeof fake.findings[0]!.body.captured_at).toBe('string')
    expect(await findings.maybeSendFindings({ config: readSyncConfig()!, findingsPath: '/v1/findings', bearer: 'cbd_secret', buildReport: build })).toBe('skipped')
    expect(fake.findings).toHaveLength(1)
  })
})

describe('findings privacy', () => {
  it('never posts absolute paths, commands or explanations', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--share-findings')
    const { maybeSendFindings } = await import('../src/sync/findings.js')
    const { readSyncConfig } = await import('../src/sync/config.js')
    const report = {
      period: { label: 'Last 30 days', start: null, end: null },
      summary: { healthScore: 80, healthGrade: 'B', findingCount: 1, periodCostUSD: 12.5, potentialSavingsTokens: 1000, potentialSavingsCostUSD: 0.5, byClass: {} },
      findings: [{
        id: 'junk-reads', title: 'Re-read C:\\Users\\Karl Maynard\\secret\\app.ts and /home/alice/work/app/x.ts often',
        explanation: 'cat /etc/passwd in C:\Users\bob\proj', severity: 'high', trend: null, tokensSaved: 1000,
        estimatedSavingsUSD: 0.5, class: 'fix', basis: 'estimated', fix: { type: 'paste', text: 'rm /home/alice/work/app/x.ts' },
      }],
      topReworkedFiles: [{ file: '/home/alice/work/app/x.ts', edits: 9 }],
      coachingNotes: ['look at C:\Users\bob\proj'],
    }
    expect(await maybeSendFindings({ config: readSyncConfig()!, findingsPath: '/v1/findings', bearer: 'cbd_secret', buildReport: async () => report })).toBe('sent')
    const body = JSON.stringify(fake.findings[0]!.body)
    for (const leak of ['C:\\Users', 'Karl Maynard', 'secret', '/home/alice', '/etc/passwd', 'alice', 'bob', 'topReworkedFiles', 'rm ']) {
      expect(body).not.toContain(leak)
    }
    expect(fake.findings[0]!.body.findings.findings[0]).toMatchObject({ id: 'junk-reads', severity: 'high', tokensSaved: 1000, estimatedSavingsUSD: 0.5 })
  })
})

describe('sync config', () => {
  it('persists detail and findings settings; status reports the effective level', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good')
    await run('config', 'detail', 'sessions')
    await run('config', 'findings', 'on')
    const { readSyncConfig } = await import('../src/sync/config.js')
    const cfg = readSyncConfig()!
    expect(cfg.detailLevel).toBe('sessions')
    expect(cfg.shareFindings).toBe(true)

    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((m: string) => { out.push(String(m)); return true }) as never)
    await run('status')
    const text = out.join('')
    expect(text).toContain('Detail level (client setting): sessions')
    expect(text).toContain('Detail levels (server allows): summary')
    expect(text).toContain('Detail level (effective): summary')
    expect(text).toContain('Share findings: on')
  })
})

describe('consent fingerprint', () => {
  it('changes when the detail level or findings flag is raised', async () => {
    const { computeAcceptanceFingerprint, detectFingerprintChanges } = await import('../src/sync/consent.js')
    const base = { org: 'o', destination: 'd', outboundFields: ['a'], workMatching: false, scopeSinceDays: 7, cadence: 'daily' as const }
    const f0 = computeAcceptanceFingerprint({ ...base, detailLevel: 'summary', shareFindings: false })
    expect(computeAcceptanceFingerprint({ ...base })).toBe(f0)
    expect(computeAcceptanceFingerprint({ ...base, detailLevel: 'sessions' })).not.toBe(f0)
    expect(computeAcceptanceFingerprint({ ...base, shareFindings: true })).not.toBe(f0)
    const { isReductionOnly } = await import('../src/sync/consent.js')
    const high = { ...base, detailLevel: 'sessions' as const, shareFindings: true }
    expect(isReductionOnly(high, { ...base, detailLevel: 'summary', shareFindings: false })).toBe(true)
    expect(isReductionOnly(high, { ...high, shareFindings: false })).toBe(true)
    expect(isReductionOnly({ ...base }, high)).toBe(false)
    expect(isReductionOnly(high, { ...high, destination: 'other', detailLevel: 'summary' })).toBe(false)
    expect(detectFingerprintChanges({ ...base }, { ...base, detailLevel: 'sessions', shareFindings: true }))
      .toEqual(['detail level', 'findings sharing'])
  })
})
