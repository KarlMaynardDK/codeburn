import type { Db, Querier, Row } from './store.js'

/** `?` placeholders to `$n`. Our SQL never contains a literal `?` inside a string. */
export function toPgSql(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${++n}`)
}

function quoteIdent(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"'
}

export interface PgOptions {
  /** Use a dedicated schema (created if missing) as search_path. Used for test isolation. */
  schema?: string
}

export type PgDb = Db & { dropSchema(): Promise<void> }

type Queryable = { query: (s: string, p?: unknown[]) => Promise<{ rows: Row[] }> }

export async function openPostgres(url: string, opts: PgOptions = {}): Promise<PgDb> {
  const imported = (await import('pg')) as any
  const mod = imported.default ?? imported
  // BIGINT (20) and NUMERIC (1700) arrive as strings by default; the store works in JS numbers.
  const types = {
    getTypeParser: (oid: number, fmt?: string) =>
      (oid === 20 || oid === 1700 ? (v: string) => Number(v) : mod.types.getTypeParser(oid, fmt)),
  }
  if (opts.schema) {
    const admin = new mod.Client({ connectionString: url })
    await admin.connect()
    try { await admin.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(opts.schema)}`) } finally { await admin.end() }
  }
  const pool = new mod.Pool({
    connectionString: url,
    max: 8,
    types,
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  })
  const exec = async (c: Queryable, sql: string, params?: unknown[]): Promise<Row[]> =>
    (await c.query(toPgSql(sql), params)).rows
  return {
    kind: 'postgres',
    all: (sql, params) => exec(pool, sql, params),
    async tx<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn({ all: (sql, params) => exec(client, sql, params) })
        await client.query('COMMIT')
        return out
      } catch (err) {
        try { await client.query('ROLLBACK') } catch { /* connection lost */ }
        throw err
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
    async dropSchema() {
      if (opts.schema) await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(opts.schema)} CASCADE`)
    },
  }
}
