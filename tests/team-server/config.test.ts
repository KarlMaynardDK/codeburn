import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../../src/team-server/config.js'

describe('team server config env overrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('env vars win over team-server.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-team-cfg-'))
    await writeFile(join(dir, 'team-server.json'), JSON.stringify({
      accept_session_detail: false, accept_findings: true, retention_days: 30, org_name: 'File Org',
    }))
    vi.stubEnv('CODEBURN_TEAM_ACCEPT_SESSION_DETAIL', 'true')
    vi.stubEnv('CODEBURN_TEAM_ACCEPT_FINDINGS', 'off')
    vi.stubEnv('CODEBURN_TEAM_RETENTION_DAYS', '90')
    vi.stubEnv('CODEBURN_TEAM_ORG_NAME', 'Env Org')
    expect(loadConfig(dir)).toMatchObject({
      accept_session_detail: true, accept_findings: false, retention_days: 90, org_name: 'Env Org',
    })
  })

  it('applies to a freshly created config and ignores empty or invalid values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-team-cfg-'))
    vi.stubEnv('CODEBURN_TEAM_ACCEPT_SESSION_DETAIL', '1')
    vi.stubEnv('CODEBURN_TEAM_ACCEPT_FINDINGS', 'maybe')
    vi.stubEnv('CODEBURN_TEAM_RETENTION_DAYS', '-5')
    vi.stubEnv('CODEBURN_TEAM_ORG_NAME', '')
    expect(loadConfig(dir)).toEqual({
      accept_session_detail: true, accept_findings: false, retention_days: 400, org_name: '',
    })
  })
})
