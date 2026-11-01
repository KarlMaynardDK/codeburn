/**
 * Coaching snapshot: the client computes a handful of workflow counts with the
 * same functions `codeburn report` uses and uploads numbers only, once a day,
 * when the user opted in and the server advertises coaching_path.
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
vi.mock('../src/models.js', async importOriginal => ({ ...(await importOriginal<object>()), loadPricing: vi.fn(async () => {}) }))
vi.mock('../src/sync/schedule-installer.js', () => ({
  installSchedule: vi.fn(async () => {}),
  removeSchedule: vi.fn(async () => {}),
  getScheduleStatus: vi.fn(async () => ({ installed: false })),
}))

interface Fake {
  server: Server
  baseUrl: string
  traces: number
  coaching: Array<{ auth: string | undefined; version: string | string[] | undefined; body: any }>
  coachingPath: string | undefined
  coachingStatus: number
}

let fake: Fake
let tmpHome: string
const originalHome = process.env.HOME
const originalStore = process.env.CODEBURN_SYNC_TOKEN_STORE

async function startFake(): Promise<Fake> {
  const f = { traces: 0, coaching: [], coachingPath: '/v1/coaching', coachingStatus: 200 } as unknown as Fake
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
          max_batch_size: 1000, detail_levels: ['summary'], org_name: 'Acme',
          ...(f.coachingPath ? { coaching_path: f.coachingPath } : {}),
        })
      }
      if (req.url === '/v1/enroll' && req.method === 'POST') return json(200, { credential: 'cbd_secret', device_id: 'dev1', person: { name: 'Karl', email: 'k@x.dk' } })
      if (req.url === '/v1/traces' && req.method === 'POST') { f.traces++; return json(200, { partialSuccess: {} }) }
      if (req.url === '/v1/coaching' && req.method === 'POST') {
        f.coaching.push({ auth: req.headers.authorization, version: req.headers['x-codeburn-client-version'], body: JSON.parse(text) })
        return json(f.coachingStatus, { ok: f.coachingStatus === 200 })
      }
      json(404, {})
    })
  })
  await new Promise<void>(r => f.server.listen(0, '127.0.0.1', r))
  f.baseUrl = `http://127.0.0.1:${(f.server.address() as { port: number }).port}`
  return f
}

function call(ts: string, tools: string[], file?: string): ParsedApiCall {
  return {
    provider: 'test', model: 'test-model',
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0 },
    costUSD: 0.01, tools, mcpTools: [], skills: [], subagentTypes: [], hasAgentSpawn: false,
    hasPlanMode: false, speed: 'standard', timestamp: ts, bashCommands: [], deduplicationKey: `${ts}-${tools.join()}-${file ?? ''}`,
    ...(file ? { toolSequence: [[{ tool: tools[0]!, file }]] } : {}),
  } as unknown as ParsedApiCall
}

/** A session with an opener, then a correction-shaped follow-up whose first edit lands 120s after the start. */
function session(id: string, file: string): SessionSummary {
  const start = Date.now() - 3600_000
  const iso = (ms: number) => new Date(start + ms).toISOString()
  return {
    sessionId: id, project: 'app', firstTimestamp: iso(0), lastTimestamp: iso(130_000),
    totalCostUSD: 0.02, totalSavingsUSD: 0, totalInputTokens: 20, totalOutputTokens: 10,
    totalReasoningTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, apiCalls: 2,
    turns: [
      { userMessage: 'SECRET PROMPT build the widget', assistantCalls: [call(iso(0), ['Read'])], timestamp: iso(0), sessionId: id, category: 'coding', retries: 0, hasEdits: false },
      { userMessage: "that's wrong, you broke SECRET FOLLOWUP", assistantCalls: [call(iso(120_000), ['Edit'], file)], timestamp: iso(120_000), sessionId: id, category: 'coding', retries: 0, hasEdits: true },
    ],
    modelBreakdown: {}, toolBreakdown: {}, mcpBreakdown: {}, bashBreakdown: {},
    categoryBreakdown: {}, skillBreakdown: {}, subagentBreakdown: {},
    workingDirectory: '/home/alice/work/widget',
  } as unknown as SessionSummary
}

function projects(): ProjectSummary[] {
  const file = '/home/alice/work/widget/src/secret-app.ts'
  return [{ project: 'app', projectPath: '/home/alice/work/widget', sessions: [session('s1', file), session('s2', file), session('s3', file)] } as ProjectSummary]
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
  tmpHome = await mkdtemp(join(tmpdir(), 'codeburn-coaching-'))
  setHome(tmpHome)
  process.env.XDG_CACHE_HOME = join(tmpHome, '.cache')
  fake.traces = 0
  fake.coaching.length = 0
  fake.coachingPath = '/v1/coaching'
  fake.coachingStatus = 200
  parseAllSessionsMock.mockResolvedValue(projects())
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})
afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = 0
  setHome(originalHome)
  await rm(tmpHome, { recursive: true, force: true })
})

const stringsOutsidePeriod = (value: unknown, path = ''): string[] => {
  if (typeof value === 'string') return path.startsWith('period.') ? [] : [`${path}=${value}`]
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsOutsidePeriod(v, `${path}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => stringsOutsidePeriod(v, path ? `${path}.${k}` : k))
  return []
}

describe('summarizeCoaching', () => {
  it('reduces sessions to counts using the report functions', async () => {
    const { summarizeCoaching } = await import('../src/sync/coaching.js')
    const snap = summarizeCoaching(projects(), { label: 'Last 30 days', start: '2026-10-01', end: '2026-10-31' })
    expect(snap).toEqual({
      period: { label: 'Last 30 days', start: '2026-10-01', end: '2026-10-31' },
      user_turns: 6,
      corrections: 3,
      sessions_with_edits: 3,
      median_time_to_first_edit_ms: 120_000,
      reworked_files: { files_in_3plus_sessions: 1, max_sessions: 3, max_edits: 3 },
    })
  })

  it('reports zeros and a null median when nothing was edited', async () => {
    const { summarizeCoaching } = await import('../src/sync/coaching.js')
    expect(summarizeCoaching([])).toEqual({
      period: { label: null, start: null, end: null },
      user_turns: 0, corrections: 0, sessions_with_edits: 0, median_time_to_first_edit_ms: null,
      reworked_files: { files_in_3plus_sessions: 0, max_sessions: 0, max_edits: 0 },
    })
  })
})

describe('coaching privacy', () => {
  it('buildCoachingReport carries no strings except the period, whatever the sessions contain', async () => {
    const { buildCoachingReport, sanitizeCoachingReport } = await import('../src/sync/coaching.js')
    const report = await buildCoachingReport()
    const wire = JSON.stringify(sanitizeCoachingReport(report))
    expect(stringsOutsidePeriod(report)).toEqual([])
    for (const leak of ['SECRET', 'PROMPT', 'FOLLOWUP', '/home/alice', 'alice', 'secret-app', 'widget', 'Edit', "that's wrong"]) {
      expect(wire).not.toContain(leak)
    }
    expect(report).toMatchObject({ user_turns: 6, corrections: 3, reworked_files: { files_in_3plus_sessions: 1 } })
  })

  it('the sanitizer drops unknown keys and paths and clamps numbers', async () => {
    const { sanitizeCoachingReport } = await import('../src/sync/coaching.js')
    const out = sanitizeCoachingReport({
      period: { label: 'Last 30 days C:\\Users\\karl\\x', start: '2026-10-01', end: 42, extra: 'x' },
      user_turns: -5, corrections: Number.NaN, sessions_with_edits: Infinity, median_time_to_first_edit_ms: -1,
      reworked_files: { files_in_3plus_sessions: 2, max_sessions: '9', max_edits: 4, files: ['/home/alice/a.ts'] },
      topReworkedFiles: [{ file: '/home/alice/a.ts' }], coachingNotes: ['look at /home/alice/a.ts'], prompt: 'SECRET',
    })
    expect(out).toEqual({
      period: { label: 'Last 30 days <path>', start: '2026-10-01', end: null },
      user_turns: 0, corrections: 0, sessions_with_edits: 0, median_time_to_first_edit_ms: 0,
      reworked_files: { files_in_3plus_sessions: 2, max_sessions: 0, max_edits: 4 },
    })
    expect(JSON.stringify(out)).not.toMatch(/alice|karl|SECRET|topReworked|coachingNotes/)
    expect(sanitizeCoachingReport(null).median_time_to_first_edit_ms).toBeNull()
    expect(sanitizeCoachingReport({ median_time_to_first_edit_ms: 5000 }).median_time_to_first_edit_ms).toBe(5000)
  })
})

describe('coachingDue', () => {
  it('needs the opt-in, a server path, and no upload yet today', async () => {
    const { coachingDue } = await import('../src/sync/coaching.js')
    const { utcDay } = await import('../src/sync/findings.js')
    const now = Date.parse('2026-11-01T12:00:00Z')
    const cfg = { baseUrl: 'http://x', clientId: 'c', tracesPath: '/v1/traces', issuer: '' }
    expect(coachingDue({ ...cfg }, '/v1/coaching', now)).toBe(false)
    expect(coachingDue({ ...cfg, shareCoaching: true }, undefined, now)).toBe(false)
    expect(coachingDue({ ...cfg, shareCoaching: true }, '/v1/coaching', now)).toBe(true)
    expect(coachingDue({ ...cfg, shareCoaching: true, lastCoachingSent: utcDay(now) }, '/v1/coaching', now)).toBe(false)
    expect(coachingDue({ ...cfg, shareCoaching: true, lastCoachingSent: '2026-10-31' }, '/v1/coaching', now)).toBe(true)
  })
})

describe('maybeSendCoaching', () => {
  const setup = async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--share-coaching')
    return (await import('../src/sync/config.js')).readSyncConfig()!
  }
  const report = async () => ({ user_turns: 4, corrections: 1, sessions_with_edits: 2, median_time_to_first_edit_ms: null, reworked_files: { files_in_3plus_sessions: 0, max_sessions: 1, max_edits: 2 }, junk: '/home/alice' })

  it('uploads sanitized counts with the bearer and version header, then skips for the rest of the day', async () => {
    await setup()
    const { maybeSendCoaching } = await import('../src/sync/coaching.js')
    const { readSyncConfig } = await import('../src/sync/config.js')
    expect(await maybeSendCoaching({ config: readSyncConfig()!, coachingPath: '/v1/coaching', bearer: 'cbd_secret', buildReport: report })).toBe('sent')
    expect(fake.coaching).toHaveLength(1)
    expect(fake.coaching[0]!.auth).toBe('Bearer cbd_secret')
    expect(typeof fake.coaching[0]!.version).toBe('string')
    expect(typeof fake.coaching[0]!.body.captured_at).toBe('string')
    expect(fake.coaching[0]!.body.coaching).toMatchObject({ user_turns: 4, corrections: 1, sessions_with_edits: 2, median_time_to_first_edit_ms: null })
    expect(JSON.stringify(fake.coaching[0]!.body)).not.toContain('alice')
    expect(readSyncConfig()!.lastCoachingSent).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await maybeSendCoaching({ config: readSyncConfig()!, coachingPath: '/v1/coaching', bearer: 'cbd_secret', buildReport: report })).toBe('skipped')
    expect(fake.coaching).toHaveLength(1)
  })

  it('reports unauthorized and failed uploads without recording a send', async () => {
    await setup()
    const { maybeSendCoaching } = await import('../src/sync/coaching.js')
    const { readSyncConfig } = await import('../src/sync/config.js')
    fake.coachingStatus = 401
    expect(await maybeSendCoaching({ config: readSyncConfig()!, coachingPath: '/v1/coaching', bearer: 'cbd_secret', buildReport: report })).toBe('unauthorized')
    fake.coachingStatus = 500
    expect(await maybeSendCoaching({ config: readSyncConfig()!, coachingPath: '/v1/coaching', bearer: 'cbd_secret', buildReport: report })).toBe('failed')
    expect(await maybeSendCoaching({ config: readSyncConfig()!, coachingPath: '/v1/coaching', bearer: 'cbd_secret', buildReport: async () => { throw new Error('boom') } })).toBe('failed')
    expect(readSyncConfig()!.lastCoachingSent).toBeUndefined()
  })

  it('does nothing when the user did not opt in', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good')
    const { maybeSendCoaching } = await import('../src/sync/coaching.js')
    const { readSyncConfig } = await import('../src/sync/config.js')
    expect(await maybeSendCoaching({ config: readSyncConfig()!, coachingPath: '/v1/coaching', bearer: 'cbd_secret', buildReport: report })).toBe('skipped')
    expect(fake.coaching).toHaveLength(0)
  })
})

describe('sync commands', () => {
  it('setup --share-coaching records the server path and opt-in; push uploads once a day', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--share-coaching')
    const { readSyncConfig } = await import('../src/sync/config.js')
    expect(readSyncConfig()).toMatchObject({ shareCoaching: true, coachingPath: '/v1/coaching' })
    await run('push')
    expect(fake.coaching).toHaveLength(1)
    expect(fake.coaching[0]!.body.coaching).toMatchObject({ user_turns: 6, corrections: 3, reworked_files: { files_in_3plus_sessions: 1 } })
    expect(stringsOutsidePeriod(fake.coaching[0]!.body.coaching)).toEqual([])
    await run('push')
    expect(fake.coaching).toHaveLength(1)
  })

  it('stays off by default and never uploads', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good')
    const { readSyncConfig } = await import('../src/sync/config.js')
    expect(readSyncConfig()!.shareCoaching).toBeFalsy()
    await run('push')
    expect(fake.coaching).toHaveLength(0)
  })

  it('says so when the server does not accept coaching stats, and sends nothing', async () => {
    fake.coachingPath = undefined
    const err: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(((m: string) => { err.push(String(m)); return true }) as never)
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--share-coaching')
    expect(err.join('')).toContain('requested, but this server does not accept coaching stats')
    await run('push')
    expect(fake.coaching).toHaveLength(0)
  })

  it('config coaching on/off persists; status reports it', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good')
    const { readSyncConfig } = await import('../src/sync/config.js')
    await run('config', 'coaching', 'on')
    expect(readSyncConfig()!.shareCoaching).toBe(true)
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((m: string) => { out.push(String(m)); return true }) as never)
    await run('status')
    expect(out.join('')).toContain('Share coaching: on')
    await run('config', 'coaching', 'off')
    expect(readSyncConfig()!.shareCoaching).toBe(false)
  })

  it('turning coaching on pauses automatic sync until the changed disclosure is accepted', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good')
    await run('auto', 'enable', '--accept')
    await run('config', 'coaching', 'on')
    await run('auto', 'run')
    const { readReceipts } = await import('../src/sync/config.js')
    expect(readReceipts().at(-1)).toMatchObject({ result: 'acceptance-required', changed: ['coaching sharing'] })
    expect(fake.traces).toBe(0)
    expect(fake.coaching).toHaveLength(0)

    await run('auto', 'enable', '--accept')
    await run('auto', 'run')
    expect(readReceipts().at(-1)).toMatchObject({ result: 'pushed' })
    expect(fake.coaching).toHaveLength(1)
  })

  it('turning coaching off needs no new acceptance', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--share-coaching')
    await run('auto', 'enable', '--accept')
    await run('config', 'coaching', 'off')
    await run('auto', 'run')
    const { readReceipts } = await import('../src/sync/config.js')
    expect(readReceipts().at(-1)).toMatchObject({ result: 'pushed' })
    expect(fake.coaching).toHaveLength(0)
  })

  it('auto enable discloses coaching stats in plain words', async () => {
    await run('setup', fake.baseUrl, '--token', 'cbe_good', '--share-coaching')
    const out: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((m: string) => { out.push(String(m)); return true }) as never)
    await run('auto', 'enable', '--accept')
    expect(out.join('')).toContain('Share coaching stats: on - a daily snapshot is uploaded, counts only')
  })
})

describe('coaching consent fingerprint', () => {
  const base = { org: 'o', destination: 'd', outboundFields: ['a'], workMatching: false, scopeSinceDays: 7, cadence: 'daily' as const }

  it('is unchanged while coaching is off or absent, and changes when it is on', async () => {
    const { computeAcceptanceFingerprint, WIRE_CONTRACT_VERSION } = await import('../src/sync/consent.js')
    const oldHash = createHash('sha256').update(JSON.stringify({
      org: 'o', destination: 'd', contractVersion: WIRE_CONTRACT_VERSION, outboundFields: ['a'], workMatching: false, scopeSinceDays: 7, cadence: 'daily',
    })).digest('hex')
    expect(computeAcceptanceFingerprint(base)).toBe(oldHash)
    expect(computeAcceptanceFingerprint({ ...base, shareCoaching: false })).toBe(oldHash)
    const withLevel = computeAcceptanceFingerprint({ ...base, detailLevel: 'summary', shareFindings: false })
    expect(computeAcceptanceFingerprint({ ...base, detailLevel: 'summary', shareFindings: false, shareCoaching: false })).toBe(withLevel)
    expect(computeAcceptanceFingerprint({ ...base, shareCoaching: true })).not.toBe(oldHash)
    expect(computeAcceptanceFingerprint({ ...base, detailLevel: 'summary', shareFindings: false, shareCoaching: true })).not.toBe(withLevel)
  })

  it('names the change, and only a reduction is free', async () => {
    const { detectFingerprintChanges, isReductionOnly } = await import('../src/sync/consent.js')
    const on = { ...base, detailLevel: 'summary' as const, shareCoaching: true }
    const off = { ...base, detailLevel: 'summary' as const }
    expect(detectFingerprintChanges(off, on)).toEqual(['coaching sharing'])
    expect(detectFingerprintChanges(on, off)).toEqual(['coaching sharing'])
    expect(detectFingerprintChanges(off, { ...off, shareCoaching: false })).toEqual(['unknown'])
    expect(isReductionOnly(on, off)).toBe(true)
    expect(isReductionOnly(off, on)).toBe(false)
    expect(isReductionOnly(on, { ...on, destination: 'other', shareCoaching: false })).toBe(false)
  })

  it('the disclosure says what is and is not sent', async () => {
    const { buildDisclosure } = await import('../src/sync/consent.js')
    const input = { destination: 'Acme', destinationUrl: 'https://x', cadence: 'daily' as const, outboundFields: [], workMatching: false, scopeSinceDays: 7 }
    expect(buildDisclosure(input)).toContain('Share coaching stats: off')
    const text = buildDisclosure({ ...input, shareCoaching: true })
    expect(text).toContain('Share coaching stats: on')
    expect(text).toContain('counts only: number of prompts, number of times you corrected the assistant, number of sessions with edits, median time to first edit, and how many files were reworked across sessions')
    expect(text).toContain('never prompt text, file names or paths')
  })
})
