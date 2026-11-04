import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { Command } from 'commander'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { helpPage, postSetupSteps } from '../../src/team-server/help.js'
import { DEFAULT_CONFIG } from '../../src/team-server/config.js'
import { registerTeamCommands } from '../../src/team-server/cli.js'
import { startServer, type TestServer } from './helpers.js'

const all = { ...DEFAULT_CONFIG, accept_session_detail: true, accept_findings: true, accept_coaching: true, org_name: 'Acme' }
const cmds = (steps: ReturnType<typeof postSetupSteps>) => steps.flatMap(s => s.commands)

describe('post-setup steps', () => {
  it('lists the commands from the setup guide in order when the server accepts everything', () => {
    const steps = postSetupSteps(all)
    expect(steps.map(s => s.title)).toEqual(['Choose what to send', 'Turn automatic sync on', 'Check it', 'Push your history'])
    expect(cmds(steps)).toEqual([
      'codeburn sync config all on',
      'codeburn sync auto enable --accept',
      'codeburn sync status',
      'codeburn sync push --since all',
    ])
    expect(steps[2]!.note).toContain('Auth: enrollment (team server: Acme)')
  })

  it('offers the choice step only when the server accepts something', () => {
    const some = cmds(postSetupSteps({ ...all, accept_session_detail: false, accept_findings: false }))
    expect(some).toContain('codeburn sync config all on')
    const none = postSetupSteps({ ...DEFAULT_CONFIG })
    expect(none.map(s => s.title)).toEqual(['Turn automatic sync on', 'Check it', 'Push your history'])
    expect(none[1]!.note).toContain('Auth: enrollment (team server).')
  })
})

describe('help page', () => {
  it('covers setup, upgrade, logout and uninstall, and escapes what it interpolates', () => {
    const html = helpPage('https://cb.example.com', { ...all, org_name: '<script>alert(1)</script>' }, { installers: true, registration: true })
    for (const id of ['install', 'finish', 'sent', 'change', 'check', 'upgrade', 'another', 'logout', 'uninstall', 'trouble']) expect(html).toContain(`id="${id}"`)
    for (const c of ['codeburn sync auto enable --accept', 'codeburn sync push --since all', 'codeburn update', 'codeburn sync logout', 'npm uninstall -g codeburn', 'codeburn sync auto disable', 'codeburn sync auto updates']) expect(html).toContain(c)
    expect(html).toContain('curl -fsSL https://cb.example.com/install.sh | sh -s -- --token &lt;token&gt;')
    expect(html).toContain('href="/register"')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('tells people they can create their own token when GitLab registration is on', () => {
    const html = helpPage('https://cb.example.com', { ...DEFAULT_CONFIG }, { installers: true, registration: true, signIn: true })
    expect(html).toContain('You can create your own install token')
    expect(html).toContain('sign in with GitLab')
    expect(html).toContain('Create my install token')
    expect(html).toContain('Set up another machine')
    expect(html).not.toContain('from your admin')
  })

  it('says tokens come from an admin when GitLab sign-in is on but registration is off', () => {
    const html = helpPage('https://cb.example.com', { ...DEFAULT_CONFIG }, { installers: true, registration: false, signIn: true })
    expect(html).toContain('install token from your admin')
    expect(html).toContain('does not create tokens for you')
    expect(html).not.toContain('Create my install token')
  })

  it('leaves out installers, registration and options the server does not offer', () => {
    const html = helpPage('https://cb.example.com', { ...DEFAULT_CONFIG }, { installers: false, registration: false })
    expect(html).not.toContain('install.sh')
    expect(html).not.toContain('href="/register"')
    expect(html).toContain('install token from your admin')
    expect(html).not.toContain('Coaching stats')
    expect(html).not.toContain('config coaching on</code>')
    expect(html).toContain('codeburn sync setup https://cb.example.com --token &lt;token&gt;')
  })
})

function rawGet(t: TestServer, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(new URL(t.base).port), path, method, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /help', () => {
  let t: TestServer
  afterEach(async () => { await t?.cleanup() })

  it('is public, HTML, and only offers what this server accepts', async () => {
    t = await startServer('sqlite', { accept_coaching: true, public_url: 'https://team.example.com' })
    const r = await fetch(`${t.base}/help`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await r.text()
    expect(html).toContain('codeburn sync config coaching on')
    expect(html).not.toContain('codeburn sync config findings on')
    expect(html).toContain('https://team.example.com')
  })

  it('answers HEAD without a body and rejects a malicious Host', async () => {
    t = await startServer('sqlite')
    const head = await rawGet(t, '/help', {}, 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    const bad = await rawGet(t, '/help', { host: 'evil.com"; rm -rf /' })
    expect(bad.status).toBe(400)
    expect(bad.body).not.toContain('rm -rf')
  })
})

describe('admin output', () => {
  it('prints the follow-up steps and the help link after the setup lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-help-'))
    const program = new Command()
    registerTeamCommands(program)
    let out = ''
    const write = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => { out += String(chunk); return true }) as typeof process.stdout.write
    try {
      await program.parseAsync(['node', 'codeburn', 'team', 'admin', 'add-person', '--name', 'Ada', '--data-dir', dir, '--url', 'https://cb.example.com'])
    } finally { process.stdout.write = write }
    expect(out).toContain('Then, on that machine:')
    expect(out).toContain('codeburn sync auto enable --accept')
    expect(out).toContain('codeburn sync push --since all')
    expect(out).toContain('https://cb.example.com/help')
  })
})
