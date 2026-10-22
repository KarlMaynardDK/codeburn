import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { GitlabConfig } from '../../src/team-server/config.js'
import { inGroups } from '../../src/team-server/gitlab.js'
import { BACKENDS, daysAgo, dayStr, enrollPerson, post, send, span, startServer, viewerClient, type TestServer } from './helpers.js'

interface FakeUser { sub: string; name: string; email: string; email_verified: boolean; groups: string[] }

/** A minimal GitLab: /oauth/token accepts any code and /oauth/userinfo returns `user`. */
const gitlab = {
  server: null as Server | null,
  url: '',
  user: null as FakeUser | null,
  tokenRequests: [] as URLSearchParams[],
  failToken: false,
}

beforeAll(async () => {
  gitlab.server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      if (req.url === '/oauth/token' && req.method === 'POST') {
        gitlab.tokenRequests.push(new URLSearchParams(Buffer.concat(chunks).toString('utf-8')))
        if (gitlab.failToken) { res.writeHead(400); return void res.end('{"error":"invalid_grant"}') }
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify({ access_token: 'at_1', token_type: 'Bearer' }))
      }
      if (req.url === '/oauth/userinfo' && req.headers.authorization === 'Bearer at_1') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(JSON.stringify(gitlab.user))
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>(r => gitlab.server!.listen(0, '127.0.0.1', r))
  gitlab.url = `http://127.0.0.1:${(gitlab.server!.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(r => gitlab.server!.close(() => r()))
})

const user = (o: Partial<FakeUser> = {}): FakeUser => ({ sub: '42', name: 'Gina Lab', email: 'gina@example.com', email_verified: true, groups: [], ...o })

function gitlabConfig(o: Partial<GitlabConfig> = {}): GitlabConfig {
  return { url: gitlab.url, client_id: 'cid', client_secret: 'secret', admin_groups: ['acme/admins'], register_groups: [], ...o }
}

const PUBLIC_URL = 'http://codeburn.test'

/** Runs the login + callback round trip as a browser would; returns the callback redirect and a cookie-carrying client. */
async function signIn(t: TestServer, u: FakeUser | null, opts: { state?: string } = {}) {
  gitlab.user = u
  const start = await fetch(`${t.base}/auth/gitlab/login`, { redirect: 'manual' })
  const location = start.headers.get('location')!
  const oauthCookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!
  const state = opts.state ?? new URL(location).searchParams.get('state')!
  const cb = await fetch(`${t.base}/auth/gitlab/callback?code=c1&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { cookie: oauthCookie } })
  const session = cb.headers.getSetCookie().find(c => c.startsWith('cb_team_session='))
  const cookie = session ? session.split(';')[0]! : ''
  const origin = `http://${t.host}`
  return {
    start, location, cb, cookie,
    redirect: cb.headers.get('location'),
    get: async (path: string) => {
      const res = await fetch(t.base + path, { headers: { cookie } })
      return { status: res.status, json: (await res.json().catch(() => null)) as any }
    },
    post: (path: string, body: unknown) => post(t.base, path, body, { cookie, origin }),
  }
}

describe('inGroups', () => {
  it('matches groups and subgroups case-insensitively, not prefixes', () => {
    expect(inGroups(['Acme/Admins'], ['acme/admins'])).toBe(true)
    expect(inGroups(['acme/admins/ops'], ['acme/admins'])).toBe(true)
    expect(inGroups(['acme/admins-old'], ['acme/admins'])).toBe(false)
    expect(inGroups([], ['acme'])).toBe(false)
  })
})

describe.each(BACKENDS)('GitLab sign-in (%s)', backend => {
  let t: TestServer
  afterEach(async () => { await t?.cleanup(); gitlab.failToken = false; gitlab.tokenRequests = [] })

  it('is off unless configured, and auth-methods reports it', async () => {
    t = await startServer(backend)
    expect((await fetch(`${t.base}/auth/gitlab/login`, { redirect: 'manual' })).status).toBe(404)
    expect(await (await fetch(`${t.base}/api/team/auth-methods`)).json()).toEqual({ key: true, gitlab: false, registration: false })
    await t.cleanup()
    t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig({ register_groups: ['acme'] }) })
    expect(await (await fetch(`${t.base}/api/team/auth-methods`)).json()).toEqual({ key: true, gitlab: true, registration: true })
  })

  it('redirects to GitLab with state and PKCE, and rejects a state mismatch', async () => {
    t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig() })
    const s = await signIn(t, user({ groups: ['acme/admins'] }), { state: 'forged' })
    expect(s.start.status).toBe(302)
    const loc = new URL(s.location)
    expect(loc.origin + loc.pathname).toBe(`${gitlab.url}/oauth/authorize`)
    expect(loc.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/auth/gitlab/callback`)
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    expect(loc.searchParams.get('code_challenge')).toBeTruthy()
    expect(loc.searchParams.get('scope')).toBe('openid profile email')
    expect(s.start.headers.get('set-cookie')).toMatch(/^cb_team_oauth=.*HttpOnly; SameSite=Lax; Path=\/auth\/gitlab; Max-Age=600/)
    expect(s.redirect).toBe('/?login_error=failed')
    expect(s.cookie).toBe('')
    expect(gitlab.tokenRequests).toHaveLength(0)
  })

  it('reports a failed token exchange as failed', async () => {
    t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig() })
    gitlab.failToken = true
    const s = await signIn(t, user({ groups: ['acme/admins'] }))
    expect(s.redirect).toBe('/?login_error=failed')
  })

  it('signs in admin group members (and subgroups) with full access', async () => {
    t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig() })
    await enrollPerson(t, 'Ann')
    const s = await signIn(t, user({ groups: ['acme/admins/ops'] }))
    expect(s.redirect).toBe('/')
    expect(gitlab.tokenRequests[0]!.get('code_verifier')).toBeTruthy()
    expect(gitlab.tokenRequests[0]!.get('client_secret')).toBe('secret')
    const meta = (await s.get('/api/team/meta')).json
    expect(meta.viewer).toEqual({ name: 'Gina Lab', role: 'admin' })
    expect(meta.people.map((p: any) => p.name)).toEqual(['Ann'])
  })

  it('scopes members to their own data', async () => {
    t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig() })
    const ann = await enrollPerson(t, 'Ann', 'core', 'Gina@Example.com')
    const bob = await enrollPerson(t, 'Bob', 'web')
    await send(t, ann.cred, [span({ id: 'a1', at: daysAgo(1), cost: 3 })])
    await send(t, bob.cred, [span({ id: 'b1', at: daysAgo(1), cost: 5 })])
    const s = await signIn(t, user())
    expect(s.redirect).toBe('/')
    const q = `from=${dayStr(daysAgo(5))}&to=${dayStr(daysAgo(0))}`
    const meta = (await s.get('/api/team/meta')).json
    expect(meta).toMatchObject({ viewer: { name: 'Gina Lab', role: 'member' }, person_id: ann.person.id, teams: [] })
    expect(meta.people).toEqual([{ id: ann.person.id, name: 'Ann', team: 'core' }])
    expect((await s.get(`/api/team/overview?${q}&team=web`)).json.totals.cost).toBe(3)
    expect((await s.get(`/api/team/people?${q}&person=${bob.person.id}`)).json.people.map((p: any) => p.name)).toEqual(['Ann'])
    expect((await s.get(`/api/team/people/${bob.person.id}?${q}`)).status).toBe(404)
    expect((await s.get(`/api/team/people/${ann.person.id}?${q}`)).status).toBe(200)
    expect((await s.get(`/api/team/projects?${q}`)).json.projects[0].cost).toBe(3)
    // Revoking the person ends the session immediately.
    await t.store.revoke(ann.person.id)
    expect((await s.get('/api/team/meta')).status).toBe(401)
  })

  it('denies unverified emails and unknown users when registration is off', async () => {
    t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig() })
    await enrollPerson(t, 'Ann', 'core', 'gina@example.com')
    expect((await signIn(t, user({ email_verified: false }))).redirect).toBe('/?login_error=denied')
    expect((await signIn(t, user({ email: 'other@example.com', groups: ['acme'] }))).redirect).toBe('/?login_error=denied')
  })

  it('keeps viewer-key login working alongside GitLab', async () => {
    t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig() })
    const v = await viewerClient(t)
    expect(v.login.status).toBe(200)
    expect((await v.get('/api/team/meta')).json.viewer).toEqual({ name: 'Boss', role: 'admin' })
  })

  describe('self-registration', () => {
    const reg = (o: Partial<GitlabConfig> = {}) => ({ public_url: PUBLIC_URL, gitlab: gitlabConfig({ register_groups: ['acme/dev'], register_note: 'Questions? Ask in #codeburn.', ...o }) })

    it('lets an unenrolled group member register with a new team and enroll a machine', async () => {
      t = await startServer(backend, reg())
      await enrollPerson(t, 'Ann', 'Platform')
      const s = await signIn(t, user({ groups: ['acme/dev/web'] }))
      expect(s.redirect).toBe('/register')
      expect((await s.get('/api/team/meta')).json).toMatchObject({ viewer: { role: 'registrant' }, teams: [], people: [], registration: true })
      expect((await s.get('/api/team/overview')).status).toBe(403)
      expect((await s.get('/api/team/people')).status).toBe(403)
      expect((await s.get('/api/team/registration')).json).toEqual({
        state: 'new', name: 'Gina Lab', email: 'gina@example.com', teams: ['Platform'], note: 'Questions? Ask in #codeburn.',
      })

      const r = await s.post('/api/team/registration', { team: '  Data Science ' })
      expect(r.status).toBe(200)
      expect(r.json.token).toMatch(/^cbe_/)
      expect(r.json.person).toEqual({ name: 'Gina Lab', email: 'gina@example.com', team: 'Data Science' })
      expect(r.json.url).toBe(PUBLIC_URL)
      expect(r.json.setup).toBe(`codeburn sync setup ${PUBLIC_URL} --token ${r.json.token}`)
      expect(r.json.install).toBeNull() // no client package configured
      expect(Date.parse(r.json.expires_at)).toBeGreaterThan(Date.now() + 6 * 86_400_000)

      // The session is now a member scoped to the new person.
      const meta = (await s.get('/api/team/meta')).json
      expect(meta.viewer.role).toBe('member')
      expect(meta.people).toEqual([{ id: meta.person_id, name: 'Gina Lab', team: 'Data Science' }])
      expect((await s.get('/api/team/overview')).status).toBe(200)

      // The token enrolls a device for that person.
      const enrolled = await post(t.base, '/v1/enroll', { token: r.json.token, label: 'laptop' })
      expect(enrolled.status).toBe(200)
      expect(enrolled.json.person).toEqual({ name: 'Gina Lab', email: 'gina@example.com' })

      // A second submit does not create a second person.
      expect((await s.post('/api/team/registration', { team: 'Other' })).status).toBe(409)
      expect((await t.store.peopleByEmail('gina@example.com'))).toHaveLength(1)

      // The new team is offered to the next registrant.
      const next = await signIn(t, user({ sub: '43', name: 'Hal', email: 'hal@example.com', groups: ['acme/dev'] }))
      expect((await next.get('/api/team/registration')).json.teams).toEqual(['Data Science', 'Platform'])
    })

    it('reuses an existing team spelling that differs only in case or spaces', async () => {
      t = await startServer(backend, reg())
      await enrollPerson(t, 'Ann', 'Platform')
      const s = await signIn(t, user({ groups: ['acme/dev'] }))
      expect((await s.post('/api/team/registration', { team: ' platform ' })).json.person.team).toBe('Platform')
    })

    it('rejects invalid team names without consuming the registration', async () => {
      t = await startServer(backend, reg())
      const s = await signIn(t, user({ groups: ['acme/dev'] }))
      for (const team of ['', '   ', 'x'.repeat(65), 'a\u0007b', 42]) {
        const r = await s.post('/api/team/registration', { team })
        expect(r.status).toBe(400)
        expect(r.json).toEqual({ error: 'invalid_team' })
      }
      expect((await s.get('/api/team/meta')).json.viewer.role).toBe('registrant')
      expect((await s.post('/api/team/registration', { team: 'core' })).status).toBe(200)
    })

    it('denies users outside register_groups, and revoked people', async () => {
      t = await startServer(backend, reg())
      expect((await signIn(t, user({ groups: ['acme/sales'] }))).redirect).toBe('/?login_error=denied')
      const { person } = await t.store.addPerson({ name: 'Gina', email: 'gina@example.com', team: 'core' })
      await t.store.revoke(person.id)
      expect((await signIn(t, user({ groups: ['acme/dev'] }))).redirect).toBe('/?login_error=denied')
    })

    it("'*' lets any verified instance user register", async () => {
      t = await startServer(backend, reg({ register_groups: ['*'] }))
      expect((await signIn(t, user())).redirect).toBe('/register')
      expect((await signIn(t, user({ email_verified: false }))).redirect).toBe('/?login_error=denied')
    })

    it('includes the installer lines when the client package is served', async () => {
      t = await startServer(backend, reg(), undefined, { file: '/nonexistent.tgz', version: '1.2.3', sha256: 'a'.repeat(64), size: 1, path: '/install/codeburn-team-1.2.3.tgz' })
      const s = await signIn(t, user({ groups: ['acme/dev'] }))
      const r = (await s.post('/api/team/registration', { team: 'core' })).json
      expect(r.install.unix).toBe(`curl -fsSL ${PUBLIC_URL}/install.sh | sh -s -- --token ${r.token}`)
      expect(r.install.windows).toContain(`irm ${PUBLIC_URL}/install.ps1`)
    })

    it('lets members create a fresh install token, invalidating the unused one', async () => {
      t = await startServer(backend, reg())
      const s = await signIn(t, user({ groups: ['acme/dev'] }))
      expect((await s.post('/api/team/registration/token', {})).status).toBe(403) // registrants register first
      const first = (await s.post('/api/team/registration', { team: 'core' })).json
      expect((await s.get('/api/team/registration')).json).toMatchObject({ state: 'member', team: 'core' })
      const fresh = await s.post('/api/team/registration/token', {})
      expect(fresh.status).toBe(200)
      expect(fresh.json.token).not.toBe(first.token)
      expect((await post(t.base, '/v1/enroll', { token: first.token })).status).toBe(401)
      expect((await post(t.base, '/v1/enroll', { token: fresh.json.token })).status).toBe(200)
      // Members added by an admin can do the same.
      await enrollPerson(t, 'Hal', 'core', 'hal@example.com')
      const hal = await signIn(t, user({ sub: '43', name: 'Hal', email: 'hal@example.com' }))
      expect((await hal.post('/api/team/registration/token', {})).status).toBe(200)
    })

    it('caps tokens per session and needs a same-origin request', async () => {
      t = await startServer(backend, reg())
      await enrollPerson(t, 'Hal', 'core', 'hal@example.com')
      const s = await signIn(t, user({ name: 'Hal', email: 'hal@example.com' }))
      expect((await post(t.base, '/api/team/registration/token', {}, { cookie: s.cookie, origin: 'https://evil.example' })).status).toBe(403)
      for (let n = 0; n < 10; n++) expect((await s.post('/api/team/registration/token', {})).status).toBe(200)
      expect((await s.post('/api/team/registration/token', {})).status).toBe(429)
    })

    it('is unavailable to admins and when registration is off', async () => {
      t = await startServer(backend, reg())
      const v = await viewerClient(t)
      expect((await v.get('/api/team/registration')).status).toBe(404)
      await t.cleanup()
      t = await startServer(backend, { public_url: PUBLIC_URL, gitlab: gitlabConfig() })
      await enrollPerson(t, 'Hal', 'core', 'hal@example.com')
      const s = await signIn(t, user({ name: 'Hal', email: 'hal@example.com' }))
      expect((await s.get('/api/team/registration')).status).toBe(404)
      expect((await s.get('/api/team/meta')).json.registration).toBe(false)
    })
  })
})
