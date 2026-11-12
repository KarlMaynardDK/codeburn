import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { parseAllSessions, clearSessionCache } from '../src/parser.js'
import { loadPricing } from '../src/models.js'

// Regression: rich-capture fields (edit LOC, tool errors, interrupted /
// userModified) were written to the session cache but dropped when cached calls
// were rebuilt into ParsedApiCall, so every consumer of parseAllSessions — sync
// push included — saw zero lines changed.
describe('rich-capture fields survive parseAllSessions', () => {
  let tmpDir: string | null = null
  const savedEnv = { config: process.env['CLAUDE_CONFIG_DIR'], cache: process.env['CODEBURN_CACHE_DIR'] }

  beforeAll(async () => {
    await loadPricing()
  })

  afterEach(async () => {
    clearSessionCache()
    if (savedEnv.config === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = savedEnv.config
    if (savedEnv.cache === undefined) delete process.env['CODEBURN_CACHE_DIR']
    else process.env['CODEBURN_CACHE_DIR'] = savedEnv.cache
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  })

  it('carries locAdded/locRemoved/toolErrors/userModified on the parsed call', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-rich-e2e-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    process.env['CODEBURN_CACHE_DIR'] = join(tmpDir, 'cache')
    const proj = join(tmpDir, 'projects', 'p')
    await mkdir(proj, { recursive: true })

    const lines = [
      { type: 'user', timestamp: '2026-07-10T09:59:59.000Z', sessionId: 's1', message: { role: 'user', content: 'edit it' } },
      {
        type: 'assistant', timestamp: '2026-07-10T10:00:00.000Z', sessionId: 's1',
        message: {
          type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', id: 'msg-1',
          content: [
            { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: '/x/a.ts', old_string: 'a', new_string: 'b' } },
            { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'false' } },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      },
      {
        type: 'user', timestamp: '2026-07-10T10:00:01.000Z', sessionId: 's1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-edit', content: 'ok' }] },
        toolUseResult: { userModified: true, structuredPatch: [{ lines: ['+a', '+b', '-c', ' ctx'] }] },
      },
      {
        type: 'user', timestamp: '2026-07-10T10:00:02.000Z', sessionId: 's1',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'exit 1', is_error: true }] },
      },
    ]
    await writeFile(join(proj, 's1.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')

    clearSessionCache()
    const projects = await parseAllSessions(undefined, 'claude')
    const calls = projects.flatMap(p => p.sessions.flatMap(s => s.turns.flatMap(t => t.assistantCalls)))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.locAdded).toBe(2)
    expect(calls[0]!.locRemoved).toBe(1)
    expect(calls[0]!.toolErrors).toBe(1)
    expect(calls[0]!.userModified).toBe(true)
  })
})
