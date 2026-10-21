import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Db, Querier, Row } from './store.js'

type Stmt = { all(...p: unknown[]): Row[] }
type Handle = { prepare(sql: string): Stmt; exec(sql: string): void; close(): void }
type Ctor = new (path: string) => Handle

let Database: Ctor | null = null

function loadDriver(): Ctor {
  if (Database) return Database
  // node:sqlite is experimental on Node 22; silence only its ExperimentalWarning, as src/sqlite.ts does.
  const proc = process as unknown as { emit: (...a: unknown[]) => boolean }
  const origEmit = proc.emit.bind(process)
  proc.emit = (name: unknown, ...args: unknown[]) => {
    const w = args[0] as { name?: string; message?: string } | undefined
    if (name === 'warning' && w?.name === 'ExperimentalWarning' && /sqlite/i.test(w.message ?? '')) return false
    return origEmit(name, ...args)
  }
  try {
    const req = createRequire(import.meta.url)
    Database = (req('node:sqlite') as { DatabaseSync: Ctor }).DatabaseSync
    return Database
  } catch (err) {
    throw new Error(`node:sqlite is unavailable (${(err as Error).message}). Use Node >= 22.13 or pass --database-url for PostgreSQL.`)
  } finally {
    proc.emit = origEmit
  }
}

/** Writable SQLite adapter. All access is serialised, which also makes async transactions safe on one connection. */
export function openSqlite(dataDir: string): Db {
  const handle = new (loadDriver())(join(dataDir, 'team.db'))
  handle.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  let chain: Promise<unknown> = Promise.resolve()
  const lock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }
  const exec = (sql: string, params: unknown[] = []): Row[] =>
    handle.prepare(sql).all(...params).map(r => ({ ...r }))
  const inner: Querier = { all: async (sql, params) => exec(sql, params) }
  return {
    kind: 'sqlite',
    all: (sql, params) => lock(async () => exec(sql, params)),
    tx: fn => lock(async () => {
      handle.exec('BEGIN IMMEDIATE')
      try {
        const out = await fn(inner)
        handle.exec('COMMIT')
        return out
      } catch (err) {
        try { handle.exec('ROLLBACK') } catch { /* already rolled back */ }
        throw err
      }
    }),
    close: () => lock(async () => { handle.close() }),
  }
}
