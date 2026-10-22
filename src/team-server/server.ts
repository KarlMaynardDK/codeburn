import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApi, readBody, sendJson } from './api.js'
import { FailureLimiter, OAUTH_COOKIE, bearer, clearedOauthCookie, oauthCookie, readCookie, sessionCookie } from './auth.js'
import { installPs1Script, installShScript, originFromRequest, type ClientPackage } from './client-package.js'
import { assertServeConfig, type TeamServerConfig } from './config.js'
import { checkState, completeLogin, decideAccess, startLogin } from './gitlab.js'
import { ingestOtlp } from './ingest.js'
import type { Store } from './store.js'

export const MAX_BODY_BYTES = 10 * 1024 * 1024
export const MAX_BATCH_SIZE = 1000

export interface TeamServerOptions {
  store: Store
  config: TeamServerConfig
  /** Directory holding the built viewer (team.html / index.html). Defaults to dist/team-dash. */
  staticDir?: string
  tls?: { cert: string; key: string }
  /** CLI build distributed at /install/*; the endpoints 404 when absent. */
  clientPackage?: ClientPackage
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
}

const HINT_HTML = `<!doctype html><meta charset="utf-8"><title>CodeBurn team server</title>
<body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>CodeBurn team server is running</h1>
<p>The report viewer has not been built. Run <code>npm run build:dash</code> and restart the server.</p>
<p>The collector endpoints and <code>/api/team/*</code> are available.</p></body>`

export function defaultStaticDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const c of [join(here, 'team-dash'), join(here, '..', 'dist', 'team-dash'), join(here, '..', '..', 'dist', 'team-dash')]) {
    if (existsSync(c)) return c
  }
  return join(here, '..', '..', 'dist', 'team-dash')
}

function indexFile(dir: string): string | null {
  for (const name of ['team.html', 'index.html']) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

function serveStatic(dir: string, pathname: string, res: ServerResponse, head: boolean): void {
  const index = indexFile(dir)
  if (!index) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return void res.end(head ? undefined : HINT_HTML)
  }
  let file = index
  if (pathname !== '/' && pathname !== '/index.html' && pathname !== '/team.html') {
    let decoded = pathname
    try { decoded = decodeURIComponent(pathname) } catch { /* keep raw */ }
    const candidate = resolve(dir, normalize('.' + sep + decoded))
    const root = resolve(dir)
    if (candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile()) file = candidate
    else if (extname(decoded)) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return void res.end('Not found')
    }
  }
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const immutable = file !== index && /[-.][A-Za-z0-9_]{8,}\./.test(file)
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(head ? undefined : readFileSync(file))
}

export function discoveryDoc(config: TeamServerConfig, pkg?: ClientPackage) {
  return {
    version: 1,
    auth: 'enrollment',
    enroll_path: '/v1/enroll',
    revoke_path: '/v1/revoke',
    traces_path: '/v1/traces',
    max_batch_size: MAX_BATCH_SIZE,
    detail_levels: config.accept_session_detail ? ['summary', 'sessions'] : ['summary'],
    ...(config.accept_findings ? { findings_path: '/v1/findings' } : {}),
    org_name: config.org_name,
    ...(pkg ? { client_package: { version: pkg.version, sha256: pkg.sha256, path: pkg.path } } : {}),
  }
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req, MAX_BODY_BYTES)
  if (raw === 'too_large') { sendJson(res, 413, { error: 'payload_too_large' }); return null }
  try {
    const parsed = JSON.parse(raw.toString('utf-8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* fall through */ }
  sendJson(res, 400, { error: 'malformed_json' })
  return null
}

export function createTeamServer(opts: TeamServerOptions): Server {
  const { store, config } = opts
  assertServeConfig(config)
  const staticDir = opts.staticDir ?? defaultStaticDir()
  const tls = !!opts.tls
  const limiter = new FailureLimiter()
  const enrollLimiter = new FailureLimiter(20, 60_000)
  const tokenLimiter = new FailureLimiter(10, 3600_000)

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (path === '/.well-known/codeburn-export.json' && (method === 'GET' || method === 'HEAD')) {
      return sendJson(res, 200, discoveryDoc(config, opts.clientPackage))
    }

    const pkg = opts.clientPackage
    if (pkg && (method === 'GET' || method === 'HEAD') &&
        (path === '/install/codeburn-team.tgz' || path === '/install/codeburn.tgz' || path === pkg.path || path === '/install.sh' || path === '/install.ps1')) {
      if (path === '/install.sh' || path === '/install.ps1') {
        const fwd = req.headers['x-forwarded-proto']
        const origin = config.public_url
          ?? originFromRequest(req.headers.host, Array.isArray(fwd) ? fwd[0] : fwd, tls)
        if (!origin) return sendJson(res, 400, { error: 'invalid_host' })
        const body = path === '/install.sh' ? installShScript(origin, pkg) : installPs1Script(origin, pkg)
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        return void res.end(method === 'HEAD' ? undefined : body)
      }
      const etag = `"${pkg.sha256}"`
      const immutable = path === pkg.path
      const headers = {
        'content-type': 'application/gzip', 'content-length': String(pkg.size), etag,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
      }
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return void res.end() }
      res.writeHead(200, headers)
      if (method === 'HEAD') return void res.end()
      return void createReadStream(pkg.file).pipe(res)
    }

    if (path === '/v1/enroll') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
      const ip = req.socket.remoteAddress ?? 'unknown'
      if (enrollLimiter.blocked(ip)) return sendJson(res, 429, { error: 'too_many_attempts' })
      const body = await readJson(req, res)
      if (!body) return
      const token = typeof body.token === 'string' ? body.token : ''
      const label = typeof body.label === 'string' ? body.label.slice(0, 128) : null
      const clientId = typeof body.device_id === 'string' ? body.device_id.slice(0, 64) : null
      const result = token.startsWith('cbe_') ? await store.enroll(token, label, clientId) : null
      if (!result) {
        enrollLimiter.fail(ip)
        return sendJson(res, 401, { error: 'invalid_or_expired_token' })
      }
      return sendJson(res, 200, result)
    }

    // A device revokes its own credential (`codeburn sync logout`); it cannot touch any other device.
    if (path === '/v1/revoke') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
      const cred = bearer(req)
      const identity = cred ? await store.authenticateDevice(cred) : null
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })
      await store.revoke(identity.deviceId)
      process.stderr.write(`team-server: device ${identity.deviceId} revoked itself\n`)
      return sendJson(res, 200, { ok: true })
    }

    if (path === '/v1/traces' || path === '/v1/findings') {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' })
      const cred = bearer(req)
      const identity = cred ? await store.authenticateDevice(cred) : null
      if (!identity) return sendJson(res, 401, { error: 'unauthorized' })

      if (path === '/v1/findings') {
        if (!config.accept_findings) return sendJson(res, 404, { error: 'findings_disabled' })
        const body = await readJson(req, res)
        if (!body) return
        if (!body.findings || typeof body.findings !== 'object') return sendJson(res, 400, { error: 'findings_required' })
        const captured = typeof body.captured_at === 'string' && !Number.isNaN(Date.parse(body.captured_at))
          ? new Date(body.captured_at).toISOString() : new Date().toISOString()
        await store.saveFindings(identity.personId, captured, JSON.stringify(body.findings))
        return sendJson(res, 200, { ok: true })
      }

      const body = await readJson(req, res)
      if (!body) return
      const count = countSpans(body)
      if (count > MAX_BATCH_SIZE) return sendJson(res, 413, { error: 'batch_too_large', max_batch_size: MAX_BATCH_SIZE })
      const r = await ingestOtlp(store, config, identity, body)
      return sendJson(res, 200, {
        partialSuccess: r.rejected > 0 ? { rejectedSpans: r.rejected, errorMessage: r.errorMessage ?? 'some spans rejected' } : {},
      })
    }

    if (path.startsWith('/api/team/') || path === '/api/team') {
      return handleApi({ store, config, tls, limiter, tokenLimiter, installers: !!opts.clientPackage }, req, res, url)
    }

    if ((path === '/auth/gitlab/login' || path === '/auth/gitlab/callback') && config.gitlab && config.public_url) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' })
      const gitlab = config.gitlab
      const publicUrl = config.public_url
      const secure = tls || req.headers['x-forwarded-proto'] === 'https' || publicUrl.startsWith('https:')
      const redirect = (location: string, cookies: string[]) => {
        res.writeHead(302, { location, 'cache-control': 'no-store', 'set-cookie': cookies })
        res.end()
      }
      if (path === '/auth/gitlab/login') {
        const start = startLogin(gitlab, publicUrl)
        return redirect(start.location, [oauthCookie(start.cookie, secure)])
      }
      const ip = req.socket.remoteAddress ?? 'unknown'
      const cleared = clearedOauthCookie(secure)
      if (limiter.blocked(ip)) return redirect('/?login_error=failed', [cleared])
      const verifier = checkState(readCookie(req, OAUTH_COOKIE), url.searchParams.get('state'))
      const code = url.searchParams.get('code')
      if (!verifier || !code) {
        limiter.fail(ip)
        return redirect('/?login_error=failed', [cleared])
      }
      let access
      let subject: string
      try {
        const info = await completeLogin(gitlab, publicUrl, code, verifier)
        subject = info.sub
        access = await decideAccess(store, gitlab, info)
        if (!access) process.stderr.write(`team-server: GitLab sign-in denied for ${info.email || info.sub}
`)
      } catch (err) {
        process.stderr.write(`team-server: GitLab sign-in failed: ${(err as Error).message}
`)
        limiter.fail(ip)
        return redirect('/?login_error=failed', [cleared])
      }
      if (!access) {
        limiter.fail(ip)
        return redirect('/?login_error=denied', [cleared])
      }
      const token = await store.loginSso({ ...access, subject })
      return redirect(access.role === 'registrant' ? '/register' : '/', [cleared, sessionCookie(token, secure)])
    }

    if (method === 'GET' || method === 'HEAD') {
      if (path.startsWith('/v1/') || path.startsWith('/api/') || path.startsWith('/auth/') || path.startsWith('/install/') || path === '/install.sh' || path === '/install.ps1') return sendJson(res, 404, { error: 'not_found' })
      return serveStatic(staticDir, path, res, method === 'HEAD')
    }
    return sendJson(res, 404, { error: 'not_found' })
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handler(req, res).catch(err => {
      process.stderr.write(`team-server: ${(err as Error).stack ?? err}\n`)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
      else res.end()
    })
  }
  return opts.tls
    ? createHttpsServer({ cert: readFileSync(opts.tls.cert), key: readFileSync(opts.tls.key) }, listener)
    : createHttpServer(listener)
}

function countSpans(body: Record<string, unknown>): number {
  let n = 0
  for (const rs of Array.isArray(body.resourceSpans) ? body.resourceSpans : [])
    for (const ss of Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : [])
      n += Array.isArray(ss?.spans) ? ss.spans.length : 0
  return n
}

/** Daily retention pruning; the timer never keeps the process alive. */
export function startRetention(store: Store, config: TeamServerConfig, log: (msg: string) => void = () => {}): () => void {
  const run = () => {
    store.prune(config.retention_days).then(
      r => { if (r.spans > 0) log(`retention: pruned ${r.spans} spans older than ${config.retention_days} days`) },
      err => log(`retention failed: ${(err as Error).message}`))
  }
  run()
  const timer = setInterval(run, 24 * 3600_000)
  timer.unref()
  return () => clearInterval(timer)
}
