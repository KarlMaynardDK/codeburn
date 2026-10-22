import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Command } from 'commander'

import { loadClientPackage, isSafeHost, type ClientPackage } from '../../src/team-server/client-package.js'
import { startServer, type TestServer } from './helpers.js'

function tarEntry(name: string, body: string): Buffer {
  const data = Buffer.from(body)
  const h = Buffer.alloc(512)
  h.write(name, 0)
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}

async function makePackage(version = '1.2.3', sidecar = true): Promise<{ pkg: ClientPackage; bytes: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-pkg-'))
  const bytes = gzipSync(Buffer.concat([tarEntry('package/package.json', JSON.stringify({ name: 'codeburn-team', version })), Buffer.alloc(1024)]))
  const file = join(dir, 'codeburn-team.tgz')
  await writeFile(file, bytes)
  if (sidecar) await writeFile(join(dir, 'codeburn-team.json'), JSON.stringify({ version, sha256: createHash('sha256').update(bytes).digest('hex') }))
  return { pkg: loadClientPackage(file)!, bytes }
}

/** fetch() cannot override Host, so use http.request. */
function rawGet(t: TestServer, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(new URL(t.base).port), path, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode!, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('client package distribution', () => {
  let t: TestServer
  afterEach(async () => { await t?.cleanup() })

  it('loads version and sha from the tarball when there is no sidecar', async () => {
    const { pkg, bytes } = await makePackage('2.0.0-rc.1', false)
    expect(pkg.version).toBe('2.0.0-rc.1')
    expect(pkg.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(pkg.path).toBe('/install/codeburn-team-2.0.0-rc.1.tgz')
    expect(loadClientPackage(join(tmpdir(), 'cb-missing.tgz'))).toBeNull()
  })

  it('returns 404 everywhere when unconfigured', async () => {
    t = await startServer('sqlite')
    for (const p of ['/install.sh', '/install.ps1', '/install/codeburn-team.tgz', '/install/codeburn.tgz', '/install/codeburn-team-1.2.3.tgz']) {
      expect((await fetch(t.base + p)).status).toBe(404)
    }
    const doc = await (await fetch(`${t.base}/.well-known/codeburn-export.json`)).json() as any
    expect(doc.client_package).toBeUndefined()
  })

  it('serves the tarball with sha, ETag and caching headers, and advertises it', async () => {
    const { pkg, bytes } = await makePackage()
    t = await startServer('sqlite', {}, undefined, pkg)
    const doc = await (await fetch(`${t.base}/.well-known/codeburn-export.json`)).json() as any
    expect(doc.client_package).toEqual({ version: '1.2.3', sha256: pkg.sha256, path: '/install/codeburn-team-1.2.3.tgz' })
    for (const p of ['/install/codeburn-team.tgz', '/install/codeburn.tgz', '/install/codeburn-team-1.2.3.tgz']) {
      const res = await fetch(t.base + p)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/gzip')
      expect(res.headers.get('etag')).toBe(`"${pkg.sha256}"`)
      expect(res.headers.get('content-length')).toBe(String(bytes.length))
      const body = Buffer.from(await res.arrayBuffer())
      expect(createHash('sha256').update(body).digest('hex')).toBe(pkg.sha256)
    }
    expect((await fetch(t.base + '/install/codeburn.tgz')).headers.get('cache-control')).toBe('no-cache')
    expect((await fetch(t.base + '/install/codeburn-team-1.2.3.tgz')).headers.get('cache-control')).toContain('immutable')
    const cond = await fetch(t.base + '/install/codeburn.tgz', { headers: { 'if-none-match': `"${pkg.sha256}"` } })
    expect(cond.status).toBe(304)
    expect((await fetch(t.base + '/install/codeburn-team-9.9.9.tgz')).status).toBe(404)
  })

  it('generates scripts with the derived URL and versioned path, with no accept flag', async () => {
    const { pkg } = await makePackage()
    t = await startServer('sqlite', {}, undefined, pkg)
    const sh = await (await fetch(`${t.base}/install.sh`)).text()
    expect(sh).toContain(`BASE_URL='${t.base}'`)
    expect(sh).toContain(`PKG_URL='${t.base}/install/codeburn-team-1.2.3.tgz'`)
    expect(sh).toContain('set -eu')
    expect(sh).toContain('npm ls -g codeburn --depth=0')
    expect(sh).toContain('npm uninstall -g codeburn')
    expect(sh).toContain('Replacing the public codeburn package')
    expect(sh.indexOf('npm uninstall -g codeburn')).toBeLessThan(sh.indexOf('npm install -g'))
    expect(sh).toContain('nodejs.org')
    expect(sh).not.toMatch(/--accept"/)
    expect(sh).not.toMatch(/sync auto enable --accept\b(?!\\n)/)
    const ps1 = await (await fetch(`${t.base}/install.ps1`)).text()
    expect(ps1).toContain(`$PkgUrl = '${t.base}/install/codeburn-team-1.2.3.tgz'`)
    expect(ps1).toContain("$ErrorActionPreference = 'Stop'")
    expect(ps1).toContain('npm uninstall -g codeburn')
    expect(ps1.indexOf('npm uninstall -g codeburn')).toBeLessThan(ps1.indexOf('npm install -g'))
    // Windows PowerShell 5.1 strips embedded double quotes from native args, so no node -e.
    expect(ps1).not.toContain('node -e')
    expect(ps1).toContain("-lt [version]'22.13'")
    const fwd = await rawGet(t, '/install.sh', { host: 'codeburn.example.com', 'x-forwarded-proto': 'https' })
    expect(fwd.body).toContain("BASE_URL='https://codeburn.example.com'")
  })

  it('rejects a malicious Host header with 400', async () => {
    const { pkg } = await makePackage()
    t = await startServer('sqlite', {}, undefined, pkg)
    for (const host of ['evil.com"; rm -rf /', "a'b.com", 'a.com/x', 'a.com:99999', 'a b', '$(id).com', 'a.com:80:90']) {
      for (const p of ['/install.sh', '/install.ps1']) {
        const r = await rawGet(t, p, { host })
        expect(r.status, host).toBe(400)
        expect(r.body).not.toContain('rm -rf')
      }
    }
    expect(isSafeHost('[::1]:8787')).toBe(true)
    expect(isSafeHost('host.example.com:8787')).toBe(true)
  })

  it('public_url wins over the Host header, even a bad one', async () => {
    const { pkg } = await makePackage()
    t = await startServer('sqlite', { public_url: 'https://team.example.com' }, undefined, pkg)
    const r = await rawGet(t, '/install.sh', { host: 'evil.com"; rm -rf /', 'x-forwarded-proto': 'http' })
    expect(r.status).toBe(200)
    expect(r.body).toContain("BASE_URL='https://team.example.com'")
    expect(r.body).not.toContain('evil.com')
  })
})

describe('add-person / rotate-enrollment output', () => {
  afterEach(() => { vi.restoreAllMocks() })

  async function run(args: string[]): Promise<string> {
    const { registerTeamCommands } = await import('../../src/team-server/cli.js')
    const program = new Command()
    registerTeamCommands(program)
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { out += String(c); return true }) as never)
    try {
      await program.parseAsync(['node', 'codeburn', 'team', 'admin', ...args])
    } finally {
      vi.restoreAllMocks()
    }
    return out
  }

  it('prints the one-line installers and the plain setup line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-cli-'))
    const out = await run(['add-person', '--name', 'Ada', '--data-dir', dir, '--url', 'https://cb.example.com/'])
    const token = /Enrollment token: (cbe_\S+)/.exec(out)![1]!
    expect(out).toContain(`curl -fsSL https://cb.example.com/install.sh | sh -s -- --token ${token}`)
    expect(out).toContain(`& ([scriptblock]::Create((irm https://cb.example.com/install.ps1))) -Token ${token}`)
    expect(out).toContain(`codeburn sync setup https://cb.example.com --token ${token}`)
    const id = /Created Ada \(([^)]+)\)/.exec(out)?.[1]
    expect(id).toBeTruthy()
    const out2 = await run(['rotate-enrollment', id!, '--data-dir', dir, '--url', 'https://cb.example.com'])
    expect(out2).toMatch(/curl -fsSL https:\/\/cb\.example\.com\/install\.sh \| sh -s -- --token cbe_/)
    expect(out2).toContain('install.ps1')
  })

  it('defaults the URL to public_url from team-server.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-cli-'))
    await writeFile(join(dir, 'team-server.json'), JSON.stringify({ public_url: 'https://pub.example.com' }))
    const out = await run(['add-person', '--name', 'Bo', '--data-dir', dir])
    expect(out).toContain('curl -fsSL https://pub.example.com/install.sh')
  })
})
