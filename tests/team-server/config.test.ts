import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertServeConfig, loadConfig, normalizeGitlabUrl } from '../../src/team-server/config.js'

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
      accept_session_detail: true, accept_findings: false, accept_coaching: false, install_mode: 'manual', retention_days: 400, org_name: '',
    })
  })

  it('reads accept_coaching from the file and the environment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-team-cfg-'))
    await writeFile(join(dir, 'team-server.json'), JSON.stringify({ accept_coaching: true }))
    expect(loadConfig(dir).accept_coaching).toBe(true)
    vi.stubEnv('CODEBURN_TEAM_ACCEPT_COACHING', 'off')
    expect(loadConfig(dir).accept_coaching).toBe(false)
  })
})

describe('team server GitLab config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const withFile = async (cfg: unknown) => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-team-cfg-'))
    await writeFile(join(dir, 'team-server.json'), JSON.stringify(cfg))
    return dir
  }

  it('is off unless both client_id and client_secret are set', async () => {
    expect(loadConfig(await withFile({ gitlab: { client_id: 'cid' } })).gitlab).toBeUndefined()
    expect(loadConfig(await withFile({ gitlab: 'nonsense' })).gitlab).toBeUndefined()
  })

  it('parses the gitlab block with defaults', async () => {
    const dir = await withFile({
      public_url: 'https://cb.example.com',
      gitlab: { client_id: 'cid', client_secret: 'sec', admin_groups: ['/acme/admins/', 7], register_groups: ['acme'], register_note: '  Ask in #codeburn  ' },
    })
    expect(loadConfig(dir).gitlab).toEqual({
      url: 'https://gitlab.com', client_id: 'cid', client_secret: 'sec', admin_groups: ['acme/admins'], register_groups: ['acme'], register_note: 'Ask in #codeburn',
    })
  })

  it('env vars win over the file', async () => {
    const dir = await withFile({ gitlab: { url: 'https://file.example', client_id: 'file', client_secret: 'file', admin_groups: ['a'], register_groups: ['b'] } })
    vi.stubEnv('CODEBURN_TEAM_GITLAB_URL', 'https://git.example.com/gitlab/')
    vi.stubEnv('CODEBURN_TEAM_GITLAB_CLIENT_ID', 'env-id')
    vi.stubEnv('CODEBURN_TEAM_GITLAB_CLIENT_SECRET', 'env-secret')
    vi.stubEnv('CODEBURN_TEAM_GITLAB_ADMIN_GROUPS', 'ops, acme/admins')
    vi.stubEnv('CODEBURN_TEAM_GITLAB_REGISTER_GROUPS', '*')
    vi.stubEnv('CODEBURN_TEAM_GITLAB_REGISTER_NOTE', 'Env note')
    expect(loadConfig(dir).gitlab).toEqual({
      url: 'https://git.example.com/gitlab', client_id: 'env-id', client_secret: 'env-secret',
      admin_groups: ['ops', 'acme/admins'], register_groups: ['*'], register_note: 'Env note',
    })
  })

  it('can be enabled from env alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-team-cfg-'))
    vi.stubEnv('CODEBURN_TEAM_GITLAB_CLIENT_ID', 'id')
    vi.stubEnv('CODEBURN_TEAM_GITLAB_CLIENT_SECRET', 'secret')
    expect(loadConfig(dir).gitlab).toMatchObject({ url: 'https://gitlab.com', admin_groups: [], register_groups: [] })
  })

  it('normalizes the GitLab URL and rejects bad ones', () => {
    expect(normalizeGitlabUrl('https://gitlab.example.com/')).toBe('https://gitlab.example.com')
    expect(() => normalizeGitlabUrl('ftp://gitlab.example.com')).toThrow()
    expect(() => normalizeGitlabUrl('https://u:p@gitlab.example.com')).toThrow()
  })

  it('serving with GitLab sign-in needs public_url', async () => {
    const cfg = loadConfig(await withFile({ gitlab: { client_id: 'cid', client_secret: 'sec' } }))
    expect(() => assertServeConfig(cfg)).toThrow(/public_url/)
    expect(() => assertServeConfig({ ...cfg, public_url: 'https://cb.example.com' })).not.toThrow()
  })
})

describe('team server install_mode', () => {
  it('defaults to manual, reads the file and lets the env override it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-mode-'))
    expect(loadConfig(dir).install_mode).toBe('manual')
    await writeFile(join(dir, 'team-server.json'), JSON.stringify({ install_mode: 'all' }))
    expect(loadConfig(dir).install_mode).toBe('all')
    await writeFile(join(dir, 'team-server.json'), JSON.stringify({ install_mode: 'bogus' }))
    expect(loadConfig(dir).install_mode).toBe('manual')
    vi.stubEnv('CODEBURN_TEAM_INSTALL_MODE', 'all')
    expect(loadConfig(dir).install_mode).toBe('all')
    vi.unstubAllEnvs()
  })
})
