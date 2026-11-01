import type { Command } from 'commander'
import { installerLines, setupCommand } from './client-package.js'

interface StoreFlags { dataDir?: string; databaseUrl?: string }

async function withStore<T>(opts: StoreFlags, fn: (store: import('./store.js').Store) => Promise<T>): Promise<T> {
  const { loadConfig, resolveDataDir, resolveDatabaseUrl } = await import('./config.js')
  const { openStore } = await import('./open.js')
  const dataDir = resolveDataDir(opts.dataDir)
  const cfg = loadConfig(dataDir)
  const store = await openStore(dataDir, resolveDatabaseUrl(opts.databaseUrl, cfg))
  try {
    return await fn(store)
  } finally {
    await store.close()
  }
}

function fail(err: unknown): never {
  process.stderr.write(`codeburn team: ${(err as Error).message}\n`)
  process.exit(1)
}

async function setupUrl(opts: StoreFlags & { url?: string }): Promise<string> {
  if (opts.url) return opts.url
  const { loadConfig, resolveDataDir } = await import('./config.js')
  return loadConfig(resolveDataDir(opts.dataDir)).public_url ?? 'http://127.0.0.1:8787'
}

function printSetupLines(url: string, token: string): void {
  const base = url.replace(/\/$/, '')
  const l = installerLines(base, token)
  process.stdout.write(`Install CodeBurn from this server and connect (macOS/Linux):
  ${l.unix}

`)
  process.stdout.write(`Windows PowerShell:
  ${l.windows}

`)
  process.stdout.write(`Already have this build installed:
  ${setupCommand(base, token)}
`)
}

export function registerTeamCommands(program: Command): void {
  const team = program
    .command('team')
    .description('Self-hosted team usage collector and report viewer')

  const storeOpts = (c: Command) => c
    .option('--data-dir <dir>', 'Data directory (default: ~/.codeburn-team or CODEBURN_TEAM_DATA_DIR)')
    .option('--database-url <url>', 'PostgreSQL URL (default: SQLite in the data dir; or CODEBURN_TEAM_DATABASE_URL)')

  storeOpts(team
    .command('serve')
    .description('Run the team collector server (HTTP; put a TLS reverse proxy in front, or pass --tls-cert/--tls-key)')
    .option('--port <port>', 'Port to listen on', '8787')
    .option('--host <host>', 'Interface to bind', '127.0.0.1')
    .option('--tls-cert <file>', 'TLS certificate (PEM)')
    .option('--tls-key <file>', 'TLS private key (PEM)')
    .option('--client-package <path>', 'CLI tarball (npm pack) to distribute at /install/* (or CODEBURN_TEAM_CLIENT_PACKAGE)')
    .option('--public-url <url>', 'Externally reachable base URL used in install scripts (or CODEBURN_TEAM_PUBLIC_URL)'))
    .action(async (opts: StoreFlags & { port: string; host: string; tlsCert?: string; tlsKey?: string; clientPackage?: string; publicUrl?: string }) => {
      try {
        const port = Number(opts.port)
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535')
        if (!!opts.tlsCert !== !!opts.tlsKey) throw new Error('--tls-cert and --tls-key must be given together')
        const { loadConfig, normalizePublicUrl, resolveDataDir, resolveDatabaseUrl } = await import('./config.js')
        const { loadClientPackage } = await import('./client-package.js')
        const { openStore } = await import('./open.js')
        const { createTeamServer, startRetention } = await import('./server.js')
        const dataDir = resolveDataDir(opts.dataDir)
        const config = loadConfig(dataDir)
        if (opts.publicUrl) config.public_url = normalizePublicUrl(opts.publicUrl)
        const pkgPath = opts.clientPackage ?? process.env.CODEBURN_TEAM_CLIENT_PACKAGE
        const clientPackage = pkgPath ? loadClientPackage(pkgPath) ?? undefined : undefined
        const store = await openStore(dataDir, resolveDatabaseUrl(opts.databaseUrl, config))
        const log = (m: string) => process.stderr.write(`${m}\n`)
        startRetention(store, config, log)
        const server = createTeamServer({
          store, config,
          ...(clientPackage ? { clientPackage } : {}),
          ...(opts.tlsCert && opts.tlsKey ? { tls: { cert: opts.tlsCert, key: opts.tlsKey } } : {}),
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, opts.host, () => resolve())
        })
        const addr = server.address()
        const actual = typeof addr === 'object' && addr ? addr.port : port
        const scheme = opts.tlsCert ? 'https' : 'http'
        log(`codeburn team server listening on ${scheme}://${opts.host}:${actual}`)
        log(`  storage: ${resolveDatabaseUrl(opts.databaseUrl, config) ? 'PostgreSQL' : `SQLite (${dataDir})`}`)
        log(clientPackage
          ? `  client package: codeburn ${clientPackage.version} (sha256 ${clientPackage.sha256.slice(0, 12)}...) at /install.sh, /install.ps1`
          : '  client package: none (install endpoints disabled)')
        log(`  session detail accepted: ${config.accept_session_detail}, findings accepted: ${config.accept_findings}`)
        log(config.gitlab
          ? `  GitLab sign-in: ${config.gitlab.url}, self-registration ${config.gitlab.register_groups.length > 0 ? 'on' : 'off'}`
          : '  GitLab sign-in: off')
        const stop = () => { server.close(() => { store.close().finally(() => process.exit(0)) }); setTimeout(() => process.exit(0), 3000).unref() }
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
      } catch (err) {
        fail(err)
      }
    })

  const admin = team.command('admin').description('Manage people, devices and viewer keys (run on the server host)')

  storeOpts(admin
    .command('add-person')
    .description('Create a person and print a one-time enrollment token')
    .requiredOption('--name <name>', 'Display name')
    .option('--email <email>', 'Email address', '')
    .option('--team <team>', 'Team name', '')
    .option('--url <url>', 'Server URL to put in the setup lines (default: public_url from config, else http://127.0.0.1:8787)'))
    .action(async (opts: StoreFlags & { name: string; email: string; team: string; url?: string }) => {
      try {
        await withStore(opts, async store => {
          const { person, enrollmentToken } = await store.addPerson({ name: opts.name, email: opts.email, team: opts.team })
          process.stdout.write(`Created ${person.name} (${person.id}). The token is single-use and expires in 7 days.\n\n`)
          process.stdout.write(`Enrollment token: ${enrollmentToken}\n\n`)
          printSetupLines(await setupUrl(opts), enrollmentToken)
        })
      } catch (err) { fail(err) }
    })

  storeOpts(admin.command('list').description('List people and their devices'))
    .action(async (opts: StoreFlags) => {
      try {
        await withStore(opts, async store => {
          const people = await store.listPeople()
          if (people.length === 0) { process.stdout.write('No people yet. Use `codeburn team admin add-person`.\n'); return }
          for (const p of people) {
            process.stdout.write(`${p.id}  ${p.name}${p.email ? ` <${p.email}>` : ''}${p.team ? `  [${p.team}]` : ''}${p.revoked_at ? '  REVOKED' : ''}\n`)
            for (const d of p.devices) {
              process.stdout.write(`    ${d.id}  ${d.label ?? '(no label)'}  last seen ${d.last_seen ?? 'never'}${d.revoked_at ? '  REVOKED' : ''}\n`)
            }
          }
        })
      } catch (err) { fail(err) }
    })

  storeOpts(admin.command('revoke <id>').description('Revoke a person (all devices) or a single device by id'))
    .action(async (id: string, opts: StoreFlags) => {
      try {
        await withStore(opts, async store => {
          const kind = await store.revoke(id)
          if (!kind) { process.stderr.write(`codeburn team: no active person or device with id ${id}\n`); process.exitCode = 1; return }
          process.stdout.write(`Revoked ${kind} ${id}. Its credentials now receive 401.\n`)
        })
      } catch (err) { fail(err) }
    })

  storeOpts(admin
    .command('rotate-enrollment <person-id>')
    .description('Invalidate unused enrollment tokens and print a fresh one')
    .option('--url <url>', 'Server URL to put in the setup lines (default: public_url from config, else http://127.0.0.1:8787)'))
    .action(async (personId: string, opts: StoreFlags & { url?: string }) => {
      try {
        await withStore(opts, async store => {
          const token = await store.rotateEnrollment(personId)
          if (!token) { process.stderr.write(`codeburn team: no active person with id ${personId}\n`); process.exitCode = 1; return }
          process.stdout.write(`Enrollment token: ${token}

`)
          printSetupLines(await setupUrl(opts), token)
        })
      } catch (err) { fail(err) }
    })

  storeOpts(admin
    .command('merge-person <from-id> <to-id>')
    .description('Move all usage, sessions, attribution and devices from one person to another, then revoke the first'))
    .action(async (fromId: string, toId: string, opts: StoreFlags) => {
      try {
        await withStore(opts, async store => {
          const r = await store.mergePerson(fromId, toId)
          if (!r) {
            process.stderr.write('codeburn team: both ids must be existing, different people, and the target must not be revoked (see `codeburn team admin list`)\n')
            process.exitCode = 1
            return
          }
          process.stdout.write(`Moved ${r.spans} spans (${r.days} days) and ${r.devices} devices from ${fromId} to ${toId}. ${fromId} is now revoked.\n`)
        })
      } catch (err) { fail(err) }
    })

  storeOpts(admin
    .command('delete-person <id>')
    .description('Permanently delete a person and their devices. Refuses while they still have usage unless --force (merge first)')
    .option('--force', 'Also delete the usage they own'))
    .action(async (id: string, opts: StoreFlags & { force?: boolean }) => {
      try {
        await withStore(opts, async store => {
          const r = await store.deletePerson(id, !!opts.force)
          if (r.deleted) { process.stdout.write(`Deleted ${id} and ${r.spans} spans.\n`); return }
          process.exitCode = 1
          process.stderr.write(r.reason === 'unknown'
            ? `codeburn team: no person with id ${id}\n`
            : `codeburn team: ${id} still owns ${r.spans} spans. Run \`codeburn team admin merge-person ${id} <to-id>\` first, or pass --force to delete them.\n`)
        })
      } catch (err) { fail(err) }
    })

  storeOpts(admin.command('add-viewer').description('Create a viewer login key for the report viewer').requiredOption('--name <name>', 'Viewer name'))
    .action(async (opts: StoreFlags & { name: string }) => {
      try {
        await withStore(opts, async store => {
          const v = await store.addViewer(opts.name)
          process.stdout.write(`Created viewer ${opts.name} (${v.id}).\nViewer key (shown once): ${v.key}\n`)
        })
      } catch (err) { fail(err) }
    })
}
